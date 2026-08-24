/**
 * PROTOTYPE — throwaway. A sketch of what a `yoke/workflow` layer could feel
 * like, just rich enough to run examples/prototypes/implement-workflow.ts.
 * It answers one question: does this shape make workflows easy to read and
 * change? Nothing here is an API commitment; delete freely.
 *
 * Stances taken (each is a design decision to evaluate, not a given):
 * - A workflow is a plain async function. No DSL, no step graph, no builder.
 * - One persistent session per agent for the duration of runWorkflow;
 *   isolation across agents instead of shared context.
 * - Fail fast by default: the timeout is always on and only reply-shape
 *   errors are auto-retried (the model just needs to reformat). Repeating a
 *   turn wholesale (`retries: "transient"`) is an explicit opt-in, because
 *   only the workflow knows a repeat is safe.
 */

import { open } from "./registry.ts"
import { YokeError } from "./errors.ts"
import type { HarnessId, SessionHandle } from "./types.ts"

// ---------------------------------------------------------------------------
// Public shape

export interface AgentSpec {
  readonly harness: HarnessId
  /** Opaque pass-through, same contract as SessionOptions. */
  readonly model?: string
  readonly effort?: string
}

export interface TurnOptions {
  /** Turn timeout, always on. Default 15 minutes. */
  readonly timeoutMs?: number
  /**
   * "shape-only" (default): re-ask when the reply fails validation.
   * "transient": additionally retry harness-level transient failures on a
   * fresh session — only for turns where repeating is safe (read-only).
   */
  readonly retries?: "shape-only" | "transient"
  readonly onRetry?: (message: string) => void
}

export interface Agent {
  readonly id: string
  readonly spec: AgentSpec
  /** Plain turn; resolves with the final text. */
  run(prompt: string, opts?: TurnOptions): Promise<string>
  /** Structured turn: extract the JSON object, validate it, retry shape errors once. */
  ask<T>(prompt: string, validate: (value: unknown) => T, opts?: TurnOptions): Promise<T>
}

/** Names an agent; nothing is opened until its first turn. */
export function agent(id: string, spec: AgentSpec): Agent {
  return {
    id,
    spec,
    run: (prompt, opts) => turn({ id, spec }, prompt, opts ?? {}, undefined),
    ask: (prompt, validate, opts) => turn({ id, spec }, prompt, opts ?? {}, validate),
  }
}

/**
 * Runs one workflow body with agent lifecycle handled: every session opened
 * during the body is disposed afterwards, whatever the outcome.
 */
export async function runWorkflow<T>(body: () => Promise<T>): Promise<T> {
  try {
    return await body()
  } finally {
    for (const [id, handle] of sessions) {
      sessions.delete(id)
      await handle.dispose().catch(() => {})
    }
  }
}

// ---------------------------------------------------------------------------
// Test seam — fake agents answer locally so workflows run without harnesses.

const fakes = new Map<string, (prompt: string, call: number) => string>()
const calls = new Map<string, number>()

/** Registers a scripted reply for an agent id; call before runWorkflow. */
export function fakeAgent(id: string, reply: (prompt: string, call: number) => string): void {
  fakes.set(id, reply)
  calls.delete(id)
}

function fakeHandle(id: string): SessionHandle {
  return {
    prompt: async (input: string) => {
      const n = (calls.get(id) ?? 0) + 1
      calls.set(id, n)
      const reply = fakes.get(id)
      if (reply === undefined) throw new Error(`no fake registered for agent "${id}"`)
      return { text: reply(input, n), raw: undefined }
    },
    serialize: async () => {
      throw new Error("fake sessions do not serialize")
    },
    abort: async () => {},
    dispose: async () => {},
  }
}

// ---------------------------------------------------------------------------
// Runtime

const DEFAULT_TIMEOUT_MS = 15 * 60_000
const SHAPE_ATTEMPTS = 2 // one refusal + one corrected retry, same session
const TRANSIENT_ATTEMPTS = 5

const TRANSIENT_PATTERNS = [
  /provider\.invalid-output/,
  /unknown finish reason/i,
  /overloaded/i,
  /rate.?limit/i,
  /ECONNRESET|ECONNREFUSED|ETIMEDOUT|fetch failed|network/i,
]

function isTransient(err: unknown): boolean {
  if (!(err instanceof YokeError)) return false
  const haystack = `${err.message} ${JSON.stringify(err.raw ?? {})}`
  return TRANSIENT_PATTERNS.some((pattern) => pattern.test(haystack))
}

const backoffMs = (attempt: number): number => Math.min(2 * 4 ** attempt, 120) * 1000

const sessions = new Map<string, SessionHandle>()

async function sessionFor(a: { id: string; spec: AgentSpec }): Promise<SessionHandle> {
  const existing = sessions.get(a.id)
  if (existing !== undefined) return existing
  if (fakes.has(a.id)) return fakeHandle(a.id)
  const harness = await open(a.spec.harness)
  const handle = await harness.createSession({
    cwd: process.cwd(),
    ...(a.spec.model !== undefined ? { model: a.spec.model } : {}),
    ...(a.spec.effort !== undefined ? { effort: a.spec.effort } : {}),
  })
  sessions.set(a.id, handle)
  return handle
}

/** Drops a poisoned session so the next turn starts fresh. */
async function resetSession(id: string): Promise<void> {
  const handle = sessions.get(id)
  if (handle === undefined) return
  sessions.delete(id)
  await handle.dispose().catch(() => {})
}

function extractJson(text: string): unknown {
  const start = text.indexOf("{")
  const end = text.lastIndexOf("}")
  if (start === -1 || end <= start) throw new Error("reply contains no JSON object")
  return JSON.parse(text.slice(start, end + 1))
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

async function turn<T>(
  a: { readonly id: string; readonly spec: AgentSpec },
  initialPrompt: string,
  opts: TurnOptions,
  validate: ((value: unknown) => T) | undefined,
): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  let transientLeft = opts.retries === "transient" ? TRANSIENT_ATTEMPTS - 1 : 0
  let shapeLeft = validate !== undefined ? SHAPE_ATTEMPTS - 1 : 0
  let prompt = initialPrompt

  for (;;) {
    const handle = await sessionFor(a)

    // Transport path: one shot at getting a complete reply before the timer.
    let reply: string
    try {
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        reply = await Promise.race([
          handle.prompt(prompt).then((result) => result.text),
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(new Error(`turn timed out after ${timeoutMs}ms`)),
              timeoutMs,
            )
          }),
        ])
      } finally {
        clearTimeout(timer)
      }
    } catch (err) {
      await handle.abort().catch(() => {}) // best effort on timeout races
      if (transientLeft === 0 || !isTransient(err)) throw err
      transientLeft -= 1
      const wait = backoffMs(TRANSIENT_ATTEMPTS - 1 - transientLeft)
      ;(opts.onRetry ?? console.error)(
        `retrying "${a.id}" in ${Math.round(wait / 1000)}s after transient failure: ${String(err)}`,
      )
      await sleep(wait)
      await resetSession(a.id)
      continue
    }

    if (validate === undefined) return reply as T

    // Shape path: validation failures re-ask the SAME session — the model
    // only needs to reformat; nothing about the world changed.
    try {
      return validate(extractJson(reply))
    } catch (err) {
      if (shapeLeft === 0) throw err
      shapeLeft -= 1
      prompt = `${initialPrompt}\n\nYour previous reply was refused (${String(err)}). Reply again with ONLY corrected JSON.`
    }
  }
}

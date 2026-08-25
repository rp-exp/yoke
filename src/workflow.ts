/**
 * PROTOTYPE — throwaway. A sketch of what a `yoke/workflow` layer could feel
 * like, just rich enough to run the examples/prototypes/ workflows.
 * It answers one question: does this shape make workflows easy to read and
 * change? Nothing here is an API commitment; delete freely.
 *
 * Stances taken (each is a design decision to evaluate, not a given):
 * - A workflow is a plain async function. No DSL, no step graph, no builder.
 * - Context is a VALUE: `agent.open()` returns a conversation with its own
 *   continuing session. Sharing context = passing the value around; fresh
 *   context = opening again. Nothing is cached behind the scenes, so where
 *   context is reused is visible at the call site and in signatures.
 * - A conversation survives failed turns, but its underlying session does
 *   not: after any aborted/failed turn the next turn continues on a FRESH
 *   session. Context resets are therefore always loud (logged on retries),
 *   never silent — and workflow prompts restate what they need.
 * - Fail fast by default: the timeout is always on and only reply-shape
 *   errors are auto-retried (the model just needs to reformat; same
 *   session, same context). Repeating a turn wholesale
 *   (`retries: "transient"`) is an explicit opt-in, because only the
 *   workflow knows a repeat is safe.
 * - `ask()` validates via the Standard Schema interface, so schemas are
 *   declarative (zod/valibot/arktype — no dependency on any of them here)
 *   and TS types come from inference. Plain functions stay available for
 *   invariants a schema can't express.
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
   * "shape-only" (default): re-ask the same session when the reply fails
   * validation. "transient": additionally retry harness-level transient
   * failures — on a FRESH session (the old one is dead), so the
   * conversation's context is reset; only for turns where both repeating
   * and losing context are safe.
   */
  readonly retries?: "shape-only" | "transient"
  readonly onRetry?: (message: string) => void
}

/**
 * What `ask` accepts as its validator: any Standard Schema implementation
 * (zod, valibot, arktype — declared structurally so yoke depends on none of
 * them), or a plain function for invariants schemas can't express. Schema
 * failures feed the model's repair prompt; precise issue paths make the
 * corrected retry land far more often than a generic refusal.
 */
interface StandardIssue {
  readonly message: string
  readonly path?: readonly (PropertyKey | { readonly key: PropertyKey })[] | undefined
}

export interface Validator<T> {
  readonly "~standard": {
    readonly validate: (
      value: unknown,
    ) =>
      | { readonly value?: T; readonly issues?: readonly StandardIssue[] | undefined }
      | Promise<{ readonly value?: T; readonly issues?: readonly StandardIssue[] | undefined }>
  }
}

function formatPath(path: readonly (PropertyKey | { readonly key: PropertyKey })[] | undefined): string {
  if (path === undefined || path.length === 0) return "(root)"
  return path
    .map((segment) => (typeof segment === "object" ? String(segment.key) : String(segment)))
    .join(".")
}

function toValidatorFn<T>(validator: Validator<T> | ((value: unknown) => T)): (value: unknown) => Promise<T> {
  if (typeof validator === "function") return async (value) => validator(value)
  return async (value) => {
    const result = await validator["~standard"].validate(value)
    if (result.issues !== undefined && result.issues.length > 0) {
      throw new Error(result.issues.map((issue) => `${formatPath(issue.path)}: ${issue.message}`).join("; "))
    }
    return result.value as T
  }
}

/** One continuing context with an agent: open once, turn many times. */
export interface Conversation {
  readonly agentId: string
  /** Plain turn; resolves with the final text. */
  run(prompt: string, opts?: TurnOptions): Promise<string>
  /** Structured turn: extract the JSON object, validate it, retry shape errors once. */
  ask<T>(prompt: string, validator: Validator<T> | ((value: unknown) => T), opts?: TurnOptions): Promise<T>
}

export interface Agent {
  readonly id: string
  readonly spec: AgentSpec
  /** Opens a NEW conversation: fresh context, empty history. */
  open(): Conversation
}

/** Names an agent; nothing is opened until `open()`. */
export function agent(id: string, spec: AgentSpec): Agent {
  return { id, spec, open: () => newConversation(id, spec) }
}

/**
 * Runs one workflow body with conversation lifecycle handled: every session
 * opened during the body is disposed afterwards, whatever the outcome.
 */
export async function runWorkflow<T>(body: () => Promise<T>): Promise<T> {
  try {
    return await body()
  } finally {
    for (const conversation of live) {
      if (conversation.handle !== undefined) {
        await conversation.handle.dispose().catch(() => {})
      }
    }
    live.clear()
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

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

interface InternalConversation {
  readonly agentId: string
  readonly spec: AgentSpec
  handle: SessionHandle | undefined
}

const live = new Set<InternalConversation>()

function newConversation(agentId: string, spec: AgentSpec): Conversation {
  const conversation: InternalConversation = { agentId, spec, handle: undefined }
  live.add(conversation)
  return {
    agentId,
    run: (prompt, opts) => turn(conversation, prompt, opts ?? {}, undefined),
    ask: (prompt, validator, opts) => turn(conversation, prompt, opts ?? {}, toValidatorFn(validator)),
  }
}

async function ensureHandle(conversation: InternalConversation): Promise<SessionHandle> {
  if (conversation.handle !== undefined) return conversation.handle
  if (fakes.has(conversation.agentId)) return fakeHandle(conversation.agentId)
  const harness = await open(conversation.spec.harness)
  const handle = await harness.createSession({
    cwd: process.cwd(),
    ...(conversation.spec.model !== undefined ? { model: conversation.spec.model } : {}),
    ...(conversation.spec.effort !== undefined ? { effort: conversation.spec.effort } : {}),
  })
  conversation.handle = handle
  return handle
}

/**
 * A failed or aborted turn kills the underlying session; the conversation
 * continues on a fresh one at its next turn. Context loss is a fact of
 * harness failures — the layer's job is to make it loud, not to hide it.
 */
async function invalidate(conversation: InternalConversation): Promise<void> {
  const handle = conversation.handle
  conversation.handle = undefined
  if (handle !== undefined) await handle.dispose().catch(() => {})
}

function extractJson(text: string): unknown {
  const start = text.indexOf("{")
  const end = text.lastIndexOf("}")
  if (start === -1 || end <= start) throw new Error("reply contains no JSON object")
  return JSON.parse(text.slice(start, end + 1))
}

async function turn<T>(
  conversation: InternalConversation,
  initialPrompt: string,
  opts: TurnOptions,
  validate: ((value: unknown) => Promise<T>) | undefined,
): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  let transientLeft = opts.retries === "transient" ? TRANSIENT_ATTEMPTS - 1 : 0
  let shapeLeft = validate !== undefined ? SHAPE_ATTEMPTS - 1 : 0
  let prompt = initialPrompt

  for (;;) {
    const handle = await ensureHandle(conversation)

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
      await invalidate(conversation) // the session ate a failed turn — never trusted again
      if (transientLeft === 0 || !isTransient(err)) throw err
      transientLeft -= 1
      const wait = backoffMs(TRANSIENT_ATTEMPTS - 1 - transientLeft)
      ;(opts.onRetry ?? console.error)(
        `retrying "${conversation.agentId}" in ${Math.round(wait / 1000)}s on a FRESH session ` +
          `(context reset) after transient failure: ${String(err)}`,
      )
      await sleep(wait)
      continue
    }

    if (validate === undefined) return reply as T

    // Shape path: validation failures re-ask the SAME session — the model
    // only needs to reformat; nothing about the world changed. The refusal
    // carries the precise schema issues so the correction is mechanical.
    try {
      return await validate(extractJson(reply))
    } catch (err) {
      if (shapeLeft === 0) throw err
      shapeLeft -= 1
      ;(opts.onRetry ?? console.error)(`"${conversation.agentId}" reply refused, re-asking with the issues: ${String(err)}`)
      prompt = `${initialPrompt}\n\nYour previous reply was refused (${String(err)}). Reply again with ONLY corrected JSON.`
    }
  }
}

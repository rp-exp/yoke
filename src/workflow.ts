/**
 * PROTOTYPE — throwaway. A sketch of what a `yoke/workflow` layer could feel
 * like, just rich enough to run the examples/ workflows. It answers one
 * question: does this shape make workflows easy to read and change? Nothing
 * here is an API commitment; delete freely. Decisions are recorded in
 * docs/adr/0001-workflow-layer-plain-functions.md.
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
 *   (`retries: "transient"`) is an explicit opt-in — declared ONCE on the
 *   agent's spec when repeat-safety follows from its role (a read-only
 *   reviewer), overridable per turn for the exceptions. A turn that
 *   outlived its timeout was aborted mid-flight: overload-shaped, so it
 *   counts as transient too.
 * - `ask()` owns the WHOLE reply contract: it appends the reply-shape
 *   instruction to the prompt, extracts the JSON, validates, and feeds the
 *   precise issues back on a repair turn. The schema is stated exactly once,
 *   at the call site — never restated inside the prompt text.
 * - A fake agent is a VALUE with the same shape as a real one, injected
 *   through the same seam as the rest of the environment. No registry, no
 *   ambient test state inside the runtime.
 * - Validation goes through the Standard Schema interface (zod/valibot/
 *   arktype all fit), so TS types come from inference and plain functions
 *   stay available for invariants a schema can't express. zod is imported
 *   here only to render a zod schema's JSON shape into the prompt; other
 *   vendors get a generic JSON instruction plus the repair loop.
 */

import { z } from "zod"
import { open } from "./registry.ts"
import { YokeError } from "./errors.ts"
import type { HarnessId, SessionHandle } from "./types.ts"

// ---------------------------------------------------------------------------
// Public shape

export type RetryPolicy = "shape-only" | "transient"

export interface AgentSpec {
  readonly harness: HarnessId
  /** Opaque pass-through, same contract as SessionOptions. */
  readonly model?: string
  readonly effort?: string
  /**
   * Default for every turn of this agent. "shape-only" (default): re-ask the
   * same session when the reply fails validation. "transient": additionally
   * retry harness-level transient failures — on a FRESH session (the old one
   * is dead), so the conversation's context is reset. Declared here because
   * repeat-safety usually follows from the agent's role, not the call site.
   */
  readonly retries?: RetryPolicy
}

export interface TurnOptions {
  /** Turn timeout, always on. Default 15 minutes. */
  readonly timeoutMs?: number
  /** Overrides the agent's spec-level retry policy for this one turn. */
  readonly retries?: RetryPolicy
  readonly onRetry?: (message: string) => void
  /**
   * Backoff before transient retry attempt n (1-based). Defaults to
   * retryBackoffMs; injectable so tests drive the retry path without
   * sleeping for real.
   */
  readonly backoffMs?: (attempt: number) => number
}

/**
 * What `ask` accepts as its validator: any Standard Schema implementation
 * (zod, valibot, arktype — declared structurally so validation depends on
 * none of them), or a plain function for invariants schemas can't express.
 * Schema failures feed the model's repair prompt; precise issue paths make
 * the corrected retry land far more often than a generic refusal.
 */
interface StandardIssue {
  readonly message: string
  readonly path?: readonly (PropertyKey | { readonly key: PropertyKey })[] | undefined
}

export interface Validator<T> {
  readonly "~standard": {
    readonly vendor: string
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

/**
 * The reply-shape instruction `ask` appends to its prompt, so the schema is
 * named once at the call site. A zod schema renders its exact JSON shape;
 * any other validator gets a generic instruction and relies on the repair
 * turn's issue paths.
 */
function replyContract(validator: Validator<unknown> | ((value: unknown) => unknown)): string {
  if (typeof validator !== "function" && validator["~standard"].vendor === "zod") {
    const shape = JSON.stringify(z.toJSONSchema(validator as unknown as z.ZodType))
    return `Reply with ONLY a JSON object matching exactly:\n${shape}`
  }
  return "Reply with ONLY a JSON object."
}

/** One continuing context with an agent: open once, turn many times. */
export interface Conversation {
  readonly agentId: string
  /** Plain turn; resolves with the final text. */
  run(prompt: string, opts?: TurnOptions): Promise<string>
  /** Structured turn: states the reply contract, extracts, validates, repairs. */
  ask<T>(prompt: string, validator: Validator<T> | ((value: unknown) => T), opts?: TurnOptions): Promise<T>
  /** Releases the underlying session; safe to call twice. Workflows that open per-round conversations dispose each one when its turn finishes. */
  dispose(): Promise<void>
}

export interface Agent {
  readonly id: string
  /** Opens a NEW conversation: fresh context, empty history. */
  open(): Conversation
}

/** Names a real agent; nothing is opened until `open()`. */
export function agent(id: string, spec: AgentSpec): Agent {
  const connect = async (): Promise<SessionHandle> => {
    const harness = await open(spec.harness)
    return harness.createSession({
      cwd: process.cwd(),
      ...(spec.model !== undefined ? { model: spec.model } : {}),
      ...(spec.effort !== undefined ? { effort: spec.effort } : {}),
    })
  }
  return { id, open: () => newConversation(id, spec.retries, connect) }
}

/**
 * A scripted agent with the same shape as a real one: a fake is a value you
 * inject wherever an Agent is expected, not an entry in a registry. It still
 * flows through the normal turn machinery, so timeouts and the `ask` repair
 * loop are exercised for real. Scripting failure modes: `reply` may throw
 * (a harness-level failure) or return a never-resolving promise (a hung
 * turn). `call` counts across the agent's lifetime, surviving fresh
 * conversations and post-failure reconnects.
 */
export function fakeAgent(
  id: string,
  reply: (prompt: string, call: number) => string | Promise<string>,
  opts?: { readonly retries?: RetryPolicy },
): Agent {
  let call = 0
  const connect = async (): Promise<SessionHandle> => ({
    prompt: async (input: string) => {
      call += 1
      return { text: await reply(input, call), raw: undefined }
    },
    serialize: async () => {
      throw new Error("fake sessions do not serialize")
    },
    abort: async () => {},
    dispose: async () => {},
  })
  return { id, open: () => newConversation(id, opts?.retries, connect) }
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
// Failure vocabulary — exported so workflow tests can assert classification
// and schedule without reaching into private state.

/**
 * A turn that outlived its timeout was aborted mid-flight. Classified as
 * transient: overload-shaped, and the abort makes a fresh-session repeat
 * safe for turns that declared themselves repeatable.
 */
export class TurnTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`turn timed out after ${timeoutMs}ms`)
    this.name = "TurnTimeoutError"
  }
}

/**
 * Transient = worth repeating on a fresh session: provider streams dying
 * mid-turn, overloaded models, network hiccups, timed-out turns. Permanent
 * (policy blocks, auth, bad requests) fails immediately — retrying cannot
 * succeed and would only burn money. Patterns informed by real provider
 * errors seen in production runs.
 */
const TRANSIENT_PATTERNS = [
  /provider\.invalid-output/,
  /unknown finish reason/i,
  /overloaded/i,
  /rate.?limit/i,
  /ECONNRESET|ECONNREFUSED|ETIMEDOUT|fetch failed|network/i,
]

export function isTransientTurnFailure(err: unknown): boolean {
  if (err instanceof TurnTimeoutError) return true
  if (!(err instanceof YokeError)) return false
  const haystack = `${err.message} ${JSON.stringify(err.raw ?? {})}`
  return TRANSIENT_PATTERNS.some((pattern) => pattern.test(haystack))
}

/** Backoff before retry attempt n (1-based): 2s, 8s, 32s, 2min — capped. */
export function retryBackoffMs(attempt: number): number {
  return Math.min(2 * 4 ** (attempt - 1), 120) * 1000
}

/** Pulls the JSON object out of a reply that may carry fences or prose. */
export function extractJson(text: string): unknown {
  const start = text.indexOf("{")
  const end = text.lastIndexOf("}")
  if (start === -1 || end <= start) {
    throw new Error(`reply contains no JSON object: ${text.slice(0, 120).trim()}`)
  }
  return JSON.parse(text.slice(start, end + 1))
}

// ---------------------------------------------------------------------------
// Runtime

const DEFAULT_TIMEOUT_MS = 15 * 60_000
const SHAPE_ATTEMPTS = 2 // one refusal + one corrected retry, same session
const TRANSIENT_ATTEMPTS = 5

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

interface InternalConversation {
  readonly agentId: string
  readonly retries: RetryPolicy | undefined
  readonly connect: () => Promise<SessionHandle>
  handle: SessionHandle | undefined
}

const live = new Set<InternalConversation>()

function newConversation(
  agentId: string,
  retries: RetryPolicy | undefined,
  connect: () => Promise<SessionHandle>,
): Conversation {
  const conversation: InternalConversation = { agentId, retries, connect, handle: undefined }
  live.add(conversation)
  const dispose = async (): Promise<void> => {
    const handle = conversation.handle
    conversation.handle = undefined
    live.delete(conversation)
    if (handle !== undefined) await handle.dispose().catch(() => {})
  }
  return {
    agentId,
    run: (prompt, opts) => turn(conversation, prompt, opts ?? {}, undefined),
    ask: (prompt, validator, opts) =>
      turn(conversation, `${prompt}\n\n${replyContract(validator)}`, opts ?? {}, toValidatorFn(validator)),
    dispose,
  }
}

async function ensureHandle(conversation: InternalConversation): Promise<SessionHandle> {
  if (conversation.handle === undefined) conversation.handle = await conversation.connect()
  return conversation.handle
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

async function turn<T>(
  conversation: InternalConversation,
  initialPrompt: string,
  opts: TurnOptions,
  validate: ((value: unknown) => Promise<T>) | undefined,
): Promise<T> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const policy = opts.retries ?? conversation.retries ?? "shape-only"
  const maxAttempts = policy === "transient" ? TRANSIENT_ATTEMPTS : 1
  const backoff = opts.backoffMs ?? retryBackoffMs
  let attempt = 1
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
            timer = setTimeout(() => reject(new TurnTimeoutError(timeoutMs)), timeoutMs)
          }),
        ])
      } finally {
        clearTimeout(timer)
      }
    } catch (err) {
      await handle.abort().catch(() => {}) // best effort on timeout races
      await invalidate(conversation) // the session ate a failed turn — never trusted again
      if (attempt >= maxAttempts || !isTransientTurnFailure(err)) throw err
      const wait = backoff(attempt)
      attempt += 1
      ;(opts.onRetry ?? console.error)(
        `retrying "${conversation.agentId}" (attempt ${attempt}/${maxAttempts}) in ${Math.round(wait / 1000)}s ` +
          `on a FRESH session (context reset) after transient harness failure: ${String(err)}`,
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

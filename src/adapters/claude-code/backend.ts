import type { SDKResultMessage } from "@anthropic-ai/claude-agent-sdk"
import { YokeError } from "../../errors.ts"
import { SessionGate } from "../../session-gate.ts"
import type { TurnBackend } from "../../session-gate.ts"
import type { Harness, TurnResult } from "../../types.ts"
import type { ClaudeCodeClientLike, QueryLike } from "./client-like.ts"
import { assertSessionUUID, decodeRef, encodeRef } from "./ref.ts"

interface BackendOptions {
  readonly cwd: string
  readonly model?: string | undefined
}

/**
 * Drives one turn per query(): each prompt() spawns a fresh CLI subprocess —
 * first turn under an explicitly assigned session id, later turns with
 * `resume` so the persisted JSONL history carries over. Sessions survive the
 * orchestrator process (tier A), so dispose() is a local no-op on purpose.
 */
export class ClaudeCodeBackend implements TurnBackend {
  readonly harnessId = "claude-code" as const
  readonly ref: ReturnType<typeof encodeRef>

  private current: QueryLike | null = null
  /** Fresh sessions address their pre-assigned id directly; afterwards, resume it. */
  private turned: boolean

  constructor(
    private readonly client: ClaudeCodeClientLike,
    private readonly opts: BackendOptions,
    private readonly sessionId: string,
    firstTurn: boolean,
  ) {
    this.ref = encodeRef(sessionId)
    this.turned = !firstTurn
  }

  async startTurn(input: string): Promise<TurnResult> {
    const q = this.client.query({
      prompt: input,
      options: {
        cwd: this.opts.cwd,
        ...(this.opts.model !== undefined ? { model: this.opts.model } : {}),
        ...(this.turned ? { resume: this.sessionId } : { sessionId: this.sessionId }),
      },
    })
    this.current = q
    this.turned = true
    let result: SDKResultMessage | undefined
    try {
      // The CLI emits exactly one result message per turn; everything else is
      // progress we deliberately ignore in v1.
      for await (const message of q) {
        if (message.type === "result") {
          result = message
          break
        }
      }
    } finally {
      this.current = null
      q.close()
    }
    if (result === undefined) {
      throw new YokeError(this.harnessId, "turn ended without a result message", {
        raw: { sessionId: this.sessionId },
      })
    }
    assertSessionUUID(result.session_id)
    return turnResult(this.harnessId, result)
  }

  /**
   * interrupt() asks the CLI to stop cleanly so the JSONL records the
   * interruption; close() then reaps the process. A rejected interrupt means
   * the process already died — expected during abort races, and close() below
   * still guarantees reaping.
   */
  async abortTurn(): Promise<void> {
    const q = this.current
    if (q === null) return
    try {
      await q.interrupt()
    } catch {
      // Process already gone; the in-flight turn's rejection carries that story.
    }
    q.close()
  }
}

function turnResult(harnessId: "claude-code", result: SDKResultMessage): TurnResult {
  if (result.subtype === "success") {
    if (result.is_error) {
      throw new YokeError(harnessId, "turn ended on an API error", { raw: result })
    }
    if (result.result.length === 0) {
      throw new YokeError(harnessId, "turn finished without assistant text", { raw: result })
    }
    return { text: result.result, raw: result }
  }
  throw new YokeError(harnessId, `turn stopped early (${result.subtype})`, { raw: result })
}

/** Creates the yoke Harness over a Claude Code Agent SDK module. */
export function createClaudeCodeHarness(client: ClaudeCodeClientLike): Harness {
  return {
    id: "claude-code",
    async createSession(opts) {
      let sessionId: string
      let firstTurn: boolean
      if (opts.sessionRef !== undefined) {
        // Format validation is eager so foreign/garbage refs fail loudly
        // before any spawn. Existence is NOT checked here: a ref serialized
        // before its first turn has no persisted file yet and becomes
        // resumable only once a turn lands; an unresumable ref fails loudly
        // at prompt time with the CLI's own error in `raw`.
        sessionId = decodeRef(opts.sessionRef)
        firstTurn = false
      } else {
        // Pre-assign the id so serialize() works even before the first turn.
        sessionId = crypto.randomUUID()
        firstTurn = true
      }
      return new SessionGate(
        new ClaudeCodeBackend(client, { cwd: opts.cwd, model: opts.model }, sessionId, firstTurn),
      )
    },
  }
}

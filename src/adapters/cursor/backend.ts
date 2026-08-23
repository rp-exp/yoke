import type { RunResult } from "@cursor/sdk"
import { YokeError } from "../../errors.ts"
import { SessionGate } from "../../session-gate.ts"
import type { TurnBackend } from "../../session-gate.ts"
import type { Harness, TurnResult } from "../../types.ts"
import type { CursorClientLike, CursorRunLike, CursorSdkAgentLike } from "./client-like.ts"
import { decodeRef, encodeRef } from "./ref.ts"

interface CreateOptions {
  readonly cwd: string
  readonly model: string
}

/**
 * Drives turns over one SDKAgent handle: every prompt() is a `send()` whose
 * Run resolves via wait(). Conversation state lives in the SDK's persisted
 * checkpoint store — not on the handle — so dispose() closing the agent is a
 * local-only operation and refs stay resumable in other processes (tier A).
 */
export class CursorBackend implements TurnBackend {
  readonly harnessId = "cursor" as const
  readonly ref: ReturnType<typeof encodeRef>

  private currentRun: CursorRunLike | null = null

  // cwd/model are applied once at create/resume time; the backend only needs
  // the ready agent handle.
  constructor(private readonly agent: CursorSdkAgentLike) {
    this.ref = encodeRef(agent.agentId)
  }

  async startTurn(input: string): Promise<TurnResult> {
    const run = await this.agent.send(input)
    this.currentRun = run
    let result: RunResult
    try {
      result = await run.wait()
    } finally {
      this.currentRun = null
    }
    if (result.status !== "finished") {
      throw new YokeError(this.harnessId, `turn did not finish (${result.status})`, { raw: result })
    }
    if (result.result === undefined || result.result.length === 0) {
      throw new YokeError(this.harnessId, "turn finished without assistant text", { raw: result })
    }
    return { text: result.result, raw: result }
  }

  /**
   * cancel() makes the in-flight wait() resolve with status "cancelled",
   * which startTurn maps to a yoke error the gate classifies as aborted.
   */
  async abortTurn(): Promise<void> {
    const run = this.currentRun
    if (run === null) return
    await run.cancel()
  }

  async disposeBackend(): Promise<void> {
    this.agent.close()
  }
}

/** Creates the yoke Harness over a Cursor Agent SDK module. */
export function createCursorHarness(client: CursorClientLike): Harness {
  return {
    id: "cursor",
    async createSession(opts) {
      // Local agents have no default model (the SDK refuses to pick one), so
      // unlike other adapters this harness requires an explicit one.
      if (opts.model === undefined) {
        throw new YokeError(
          "cursor",
          'the cursor adapter requires SessionOptions.model (e.g. "composer-2.5"); discover ids via Cursor.models.list()',
        )
      }
      // Effort maps to the model's "effort" parameter (observed on grok-4.x via
      // Cursor.models.list()); models without it fail loudly at send time.
      const model =
        opts.effort !== undefined
          ? { id: opts.model, params: [{ id: "effort", value: opts.effort }] }
          : { id: opts.model }
      const options = { model, local: { cwd: opts.cwd } }
      try {
        const agent =
          opts.sessionRef !== undefined
            ? await client.agent.resume(decodeRef(opts.sessionRef), options)
            : await client.agent.create(options)
        return new SessionGate(new CursorBackend(agent))
      } catch (cause) {
        throw new YokeError("cursor", "could not create or resume the cursor agent", { cause })
      }
    },
  }
}

import { TurnAbortedError, YokeError } from "../../errors.ts"
import type { TurnBackend } from "../../session-gate.ts"
import { SessionGate } from "../../session-gate.ts"
import type { Harness, TurnResult } from "../../types.ts"
import type { OpenCodeLike } from "./client-like.ts"
import { decodeRef, encodeRef, assertSessionID, parseModelRef } from "./ref.ts"
import type { SessionMessageAssistant } from "@opencode-ai/client"

/**
 * Drives one turn against the OpenCode V2 HTTP API:
 * prompt (enqueue) → wait (long-poll until idle) → read outcome + last
 * assistant message. The service owns sessions and their history, so dispose()
 * is deliberately a no-op on the wire — refs stay resumable (tier A).
 */
export class OpenCodeBackend implements TurnBackend {
  readonly harnessId = "opencode" as const
  readonly ref: ReturnType<typeof encodeRef>

  constructor(
    private readonly client: OpenCodeLike,
    private readonly sessionID: string,
  ) {
    this.ref = encodeRef(sessionID)
  }

  async startTurn(input: string): Promise<TurnResult> {
    await this.client.session.prompt({ sessionID: this.sessionID, text: input })
    await this.client.session.wait({ sessionID: this.sessionID })

    // Validate the server's story at the boundary before trusting it.
    const info = await this.client.session.get({ sessionID: this.sessionID })
    if (info.outcome === "failed") {
      throw new YokeError(this.harnessId, "turn failed", { raw: info })
    }
    if (info.outcome === "interrupted") {
      throw new TurnAbortedError(this.harnessId, "turn was interrupted", { raw: info })
    }

    const messages = await this.client.message.list({
      sessionID: this.sessionID,
      order: "desc",
      limit: 10,
    })
    const assistant = messages.data.find((m): m is SessionMessageAssistant => m.type === "assistant")
    const text = assistant === undefined ? "" : textOf(assistant)
    if (text.length === 0) {
      throw new YokeError(this.harnessId, "turn finished without assistant text", { raw: { info, messages } })
    }
    return { text, raw: { info, message: assistant } }
  }

  async abortTurn(): Promise<void> {
    await this.client.session.interrupt({ sessionID: this.sessionID })
  }
}

function textOf(message: SessionMessageAssistant): string {
  return message.content
    .filter((part): part is Extract<typeof part, { type: "text" }> => part.type === "text")
    .map((part) => part.text)
    .join("\n")
    .trim()
}

/** Creates the yoke Harness over an OpenCode client. */
export function createOpenCodeHarness(client: OpenCodeLike): Harness {
  return {
    id: "opencode",
    async createSession(opts) {
      let sessionID: string
      if (opts.sessionRef !== undefined) {
        // Decode first so foreign/garbage refs fail loudly without a network call.
        sessionID = decodeRef(opts.sessionRef)
        try {
          const info = await client.session.get({ sessionID })
          assertSessionID(info.id)
        } catch (cause) {
          throw cause instanceof YokeError
            ? cause
            : new YokeError("opencode", `no live session for ref ${JSON.stringify(opts.sessionRef)}`, { cause })
        }
      } else {
        if (opts.effort !== undefined && opts.model === undefined) {
          // A variant only exists relative to a model ref; there is nowhere to
          // put it when the session uses the harness default.
          throw new YokeError("opencode", "SessionOptions.effort requires an explicit SessionOptions.model")
        }
        const info = await client.session.create({
          location: { directory: opts.cwd },
          ...(opts.model !== undefined
            ? {
                model: {
                  ...parseModelRef(opts.model),
                  ...(opts.effort !== undefined ? { variant: opts.effort } : {}),
                },
              }
            : {}),
        })
        sessionID = assertSessionID(info.id)
      }
      return new SessionGate(new OpenCodeBackend(client, sessionID))
    },
  }
}

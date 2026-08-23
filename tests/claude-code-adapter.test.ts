import { describe, expect, test } from "bun:test"
import type { ClaudeCodeClientLike, QueryLike } from "../src/adapters/claude-code/client-like.ts"
import { createClaudeCodeHarness } from "../src/adapters/claude-code/backend.ts"
import { decodeRef, encodeRef } from "../src/adapters/claude-code/ref.ts"
import {
  HandleBusyError,
  HandleDisposedError,
  TurnAbortedError,
  YokeError,
} from "../src/errors.ts"
import { sessionRef } from "../src/types.ts"
import type { Options, SDKMessage, SDKResultMessage } from "@anthropic-ai/claude-agent-sdk"

const CWD = process.cwd()
const UUID_A = "3f2504e0-4f89-11d3-9a0c-0305e82c3301"
const UUID_B = "7266c8e0-5b32-4d01-9f2a-1c9d4e5f6a7b"

function resultMessage(sessionId: string, overrides: Partial<Record<string, unknown>> = {}): SDKResultMessage {
  return {
    type: "result",
    subtype: "success",
    duration_ms: 0,
    duration_api_ms: 0,
    is_error: false,
    num_turns: 1,
    result: "",
    stop_reason: null,
    total_cost_usd: 0,
    usage: {} as never,
    modelUsage: {},
    permission_denials: [],
    errors: [],
    uuid: "00000000-0000-0000-0000-000000000000",
    session_id: sessionId,
    ...overrides,
  } as SDKResultMessage
}

interface RecordedQuery {
  readonly prompt: string
  readonly options: Options | undefined
}

/** Scripted query: yields `messages`, optionally hanging after each message until close(). */
function fakeQuery(messages: SDKMessage[], mode: "instant" | "hang"): QueryLike {
  let rejectWait: ((err: Error) => void) | null = null
  const query: QueryLike = {
    interrupt: async () => {},
    close: () => {
      rejectWait?.(new Error("process reaped by close()"))
    },
    async *[Symbol.asyncIterator](): AsyncGenerator<SDKMessage> {
      for (const message of messages) {
        yield message
        if (mode === "hang") {
          await new Promise<never>((_, reject) => {
            rejectWait = reject
          })
        }
      }
    },
  }
  return query
}

/**
 * Scripted SDK module. Each query() records its input; the emitted result
 * carries whichever session id the query addressed (explicit on first turn,
 * resumed afterwards), overridden per call by `results[i]` (last entry
 * repeats). An empty `results` array means the subprocess never emits a result.
 */
function fakeClient(config: {
  readonly results?: Partial<SDKResultMessage>[]
  readonly mode?: "instant" | "hang"
} = {}) {
  const recorded: RecordedQuery[] = []
  let callIndex = 0

  const client: ClaudeCodeClientLike = {
    query(params) {
      recorded.push({ prompt: params.prompt as string, options: params.options })
      const sessionId =
        params.options?.sessionId ?? params.options?.resume ?? "00000000-0000-0000-0000-000000000000"
      const count = config.results?.length ?? 1
      const overrides = config.results === undefined ? {} : config.results[Math.min(callIndex, count - 1)] ?? {}
      callIndex += 1
      const messages: SDKMessage[] = [
        { type: "system", subtype: "init", session_id: sessionId } as never,
      ]
      if (config.results === undefined || config.results.length > 0) {
        messages.push(resultMessage(sessionId, overrides))
      }
      return fakeQuery(messages, config.mode ?? "instant")
    },
  }

  return {
    client,
    recorded,
    get queryCount() {
      return recorded.length
    },
  }
}

describe("claude-code ref codec", () => {
  test("round-trips a session uuid", () => {
    expect(decodeRef(encodeRef(UUID_A))).toBe(UUID_A)
  })

  test("rejects foreign, malformed, and non-uuid refs loudly", () => {
    expect(() => decodeRef(sessionRef("opencode:v1:ses_abc"))).toThrow(YokeError)
    expect(() => decodeRef(sessionRef(`claude-code:v1:not-a-uuid`))).toThrow(YokeError)
    expect(() => decodeRef(sessionRef(""))).toThrow(YokeError)
  })
})

describe("claude-code harness turns", () => {
  test("first turn addresses an explicit session id; later turns resume it", async () => {
    const { client, recorded } = fakeClient({ results: [{ result: "ok" }] })
    const harness = createClaudeCodeHarness(client)
    const session = await harness.createSession({ cwd: CWD })

    await session.prompt("hello")
    const ref = await session.serialize()
    const sessionId = decodeRef(ref)
    expect(recorded[0]?.options?.sessionId).toBe(sessionId)
    expect(recorded[0]?.options?.resume).toBeUndefined()

    await session.prompt("again")
    expect(recorded[1]?.options?.resume).toBe(sessionId)
    expect(recorded[1]?.options?.sessionId).toBeUndefined()
  })

  test("model passes through verbatim in the harness's own vocabulary", async () => {
    const { client, recorded } = fakeClient({ results: [{ result: "ok" }] })
    const harness = createClaudeCodeHarness(client)
    const session = await harness.createSession({ cwd: CWD, model: "claude-sonnet-4-5" })
    await session.prompt("hello")
    await session.dispose()
    expect(recorded[0]?.options?.model).toBe("claude-sonnet-4-5")
  })

  test("result text becomes TurnResult.text with the raw result preserved", async () => {
    const { client } = fakeClient({ results: [{ result: "final words" }] })
    const harness = createClaudeCodeHarness(client)
    const session = await harness.createSession({ cwd: CWD })
    const turn = await session.prompt("hello")
    expect(turn.text).toBe("final words")
    expect((turn.raw as SDKResultMessage).subtype).toBe("success")
  })

  test("error outcomes fail loudly with the raw result attached", async () => {
    const apiError = fakeClient({
      results: [{ is_error: true, result: "overloaded" }],
    })
    const earlyStop = fakeClient({
      results: [{ subtype: "error_max_turns" }],
    })

    for (const { client } of [apiError, earlyStop]) {
      const harness = createClaudeCodeHarness(client)
      const session = await harness.createSession({ cwd: CWD })
      try {
        await session.prompt("hello")
        expect.unreachable()
      } catch (err) {
        expect(err).toBeInstanceOf(YokeError)
        expect((err as YokeError).raw).not.toBeNull()
      }
    }
  })

  test("a subprocess that dies without a result fails loudly", async () => {
    // Empty script = process exits without emitting a result.
    const { client } = fakeClient({ results: [], mode: "instant" })
    const harness = createClaudeCodeHarness(client)
    const session = await harness.createSession({ cwd: CWD })
    await expect(session.prompt("hello")).rejects.toThrow(/without a result/)
  })
})

describe("claude-code harness resume + gate contract", () => {
  test("resuming a never-persisted ref fails loudly at turn time", async () => {
    // The CLI reports an unresumable session as an error result.
    const { client } = fakeClient({
      results: [
        {
          subtype: "error_during_execution",
          errors: ["No conversation found with session ID"],
        },
      ],
    })
    const harness = createClaudeCodeHarness(client)
    // Creating the handle is fine (format validated); the failure is loud and
    // carries the CLI's own error text in raw.
    const session = await harness.createSession({ cwd: CWD, sessionRef: encodeRef(UUID_B) })
    try {
      await session.prompt("hello")
      expect.unreachable()
    } catch (err) {
      expect(err).toBeInstanceOf(YokeError)
      const raw = (err as YokeError).raw as { errors: string[] }
      expect(raw.errors[0]).toContain("No conversation found")
    }
  })

  test("garbage refs fail before any spawn", async () => {
    const { client, queryCount } = fakeClient({})
    await expect(
      createClaudeCodeHarness(client).createSession({ cwd: CWD, sessionRef: sessionRef("garbage") }),
    ).rejects.toThrow(YokeError)
    expect(queryCount).toBe(0)
  })

  test("serialize works before the first turn (id is pre-assigned)", async () => {
    const { client } = fakeClient({})
    const harness = createClaudeCodeHarness(client)
    const session = await harness.createSession({ cwd: CWD })
    const ref = await session.serialize()
    expect(decodeRef(ref)).toMatch(/^[0-9a-f-]{36}$/i)
    await session.dispose()
  })

  test("gate contract through the real adapter: busy, serialize, dispose", async () => {
    const { client } = fakeClient({ mode: "hang", results: [{ result: "done" }] })
    const harness = createClaudeCodeHarness(client)

    const handle = await harness.createSession({ cwd: CWD })
    const slowTurn = handle.prompt("SLOW")
    await new Promise((r) => setTimeout(r, 20))
    await expect(handle.prompt("again")).rejects.toBeInstanceOf(HandleBusyError)
    await expect(handle.serialize()).rejects.toBeInstanceOf(HandleBusyError)

    // Dispose cancels the in-flight turn by reaping the subprocess...
    await handle.dispose()
    await expect(slowTurn).rejects.toBeInstanceOf(TurnAbortedError)
    await expect(handle.prompt("after dispose")).rejects.toBeInstanceOf(HandleDisposedError)
  })

  test("resuming transfers ownership away from the old handle", async () => {
    const { client } = fakeClient({})
    const harness = createClaudeCodeHarness(client)
    const owner1 = await harness.createSession({ cwd: CWD, sessionRef: encodeRef(UUID_B) })
    const owner2 = await harness.createSession({ cwd: CWD, sessionRef: encodeRef(UUID_B) })
    await expect(owner1.prompt("stale")).rejects.toBeInstanceOf(HandleBusyError)
    await owner2.dispose()
  })

  test("abort during a hung turn rejects it as aborted and reaps the process", async () => {
    const { client } = fakeClient({ mode: "hang", results: [{ result: "ignored" }] })
    const harness = createClaudeCodeHarness(client)
    const session = await harness.createSession({ cwd: CWD })
    const turn = session.prompt("slow")
    await new Promise((r) => setTimeout(r, 20))
    await session.abort()
    await expect(turn).rejects.toBeInstanceOf(TurnAbortedError)
  })

  test("dispose does not destroy the persisted session (nothing to delete)", async () => {
    const { client } = fakeClient({})
    const harness = createClaudeCodeHarness(client)
    const session = await harness.createSession({ cwd: CWD, sessionRef: encodeRef(UUID_A) })
    await session.dispose()
    // The ref still resolves after dispose — tier A holds.
    const again = await harness.createSession({ cwd: CWD, sessionRef: encodeRef(UUID_A) })
    await again.dispose()
  })
})

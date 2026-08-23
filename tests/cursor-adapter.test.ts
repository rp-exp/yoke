import { describe, expect, test } from "bun:test"
import type {
  CursorClientLike,
  CursorRunLike,
  CursorSdkAgentLike,
} from "../src/adapters/cursor/client-like.ts"
import { createCursorHarness } from "../src/adapters/cursor/backend.ts"
import { decodeRef, encodeRef } from "../src/adapters/cursor/ref.ts"
import {
  HandleBusyError,
  HandleDisposedError,
  TurnAbortedError,
  YokeError,
} from "../src/errors.ts"
import { sessionRef } from "../src/types.ts"
import type { AgentOptions, RunResult, SendOptions } from "@cursor/sdk"

const CWD = process.cwd()
const AGENT_A = "0f0e1d2c-3b4a-4958-8677-665544332211"
const AGENT_B = "bc-fedcba98-7654-3210-1234-567890abcdef"

function runResult(overrides: Partial<Record<string, unknown>> = {}): RunResult {
  return {
    id: "run-1",
    status: "finished",
    result: "ok",
    durationMs: 10,
    ...overrides,
  } as RunResult
}

interface RecordedSend {
  readonly message: string
  readonly options: SendOptions | undefined
}

/**
 * Scripted SDK module. `mode: "hang"` makes wait() pend until cancel()
 * resolves it with a cancelled result (mirroring the real Run semantics).
 */
function fakeClient(config: {
  readonly results?: Partial<RunResult>[]
  readonly mode?: "instant" | "hang"
  readonly failCreate?: Error
  readonly failResume?: Error
} = {}) {
  const created: Array<{ options: AgentOptions }> = []
  const resumed: Array<{ agentId: string; options: Partial<AgentOptions> | undefined }> = []
  const sends: RecordedSend[] = []
  const closes: string[] = []
  let callIndex = 0

  function makeAgent(agentId: string): CursorSdkAgentLike & { runs: CursorRunLike[] } {
    const runs: CursorRunLike[] = []
    return {
      agentId,
      runs,
      async send(message: string | { text: string }, options?: SendOptions) {
        sends.push({ message: typeof message === "string" ? message : message.text, options })
        const count = config.results?.length ?? 1
        const overrides =
          config.results === undefined ? {} : config.results[Math.min(callIndex, count - 1)] ?? {}
        callIndex += 1
        let release: ((result: RunResult) => void) | null = null
        const run: CursorRunLike = {
          id: `run-${runs.length + 1}`,
          wait: () =>
            config.mode === "hang"
              ? new Promise<RunResult>((resolve) => {
                  release = resolve
                })
              : Promise.resolve(runResult(overrides)),
          cancel: async () => {
            release?.(runResult({ status: "cancelled", result: undefined }))
          },
        }
        runs.push(run)
        return run
      },
      close: () => closes.push(agentId),
    }
  }

  const client: CursorClientLike = {
    agent: {
      async create(options) {
        created.push({ options })
        if (config.failCreate !== undefined) throw config.failCreate
        return makeAgent(AGENT_A)
      },
      async resume(agentId, options) {
        resumed.push({ agentId, options })
        if (config.failResume !== undefined) throw config.failResume
        return makeAgent(agentId)
      },
    },
  }

  return {
    client,
    created,
    resumed,
    sends,
    closeCount: () => closes.length,
    get queryCount() {
      return sends.length
    },
  }
}

describe("cursor ref codec", () => {
  test("round-trips an agent id", () => {
    expect(decodeRef(encodeRef(AGENT_A))).toBe(AGENT_A)
  })

  test("rejects foreign, malformed, and empty refs loudly", () => {
    expect(() => decodeRef(sessionRef("claude-code:v1:00000000-0000-0000-0000-000000000000"))).toThrow(YokeError)
    expect(() => decodeRef(sessionRef("cursor:v1:has spaces"))).toThrow(YokeError)
    expect(() => decodeRef(sessionRef("cursor:v1:"))).toThrow(YokeError)
  })
})

describe("cursor harness turns", () => {
  test("createSession requires an explicit model (local agents have no default)", async () => {
    const { client, queryCount } = fakeClient({})
    await expect(createCursorHarness(client).createSession({ cwd: CWD })).rejects.toThrow(/requires SessionOptions\.model/)
    expect(queryCount).toBe(0)
  })

  test("effort is rejected loudly (param vocabulary unverifiable without a live key)", async () => {
    const { client, queryCount } = fakeClient({})
    await expect(
      createCursorHarness(client).createSession({ cwd: CWD, model: "grok-4.6", effort: "high" }),
    ).rejects.toThrow(/does not support SessionOptions\.effort/)
    expect(queryCount).toBe(0)
  })

  test("model and cwd pass through into create; send reuses one agent handle", async () => {
    const { client, created, sends } = fakeClient({ results: [{ result: "one" }, { result: "two" }] })
    const harness = createCursorHarness(client)
    const session = await harness.createSession({ cwd: CWD, model: "composer-2.5" })

    const first = await session.prompt("hello")
    expect(first.text).toBe("one")
    expect((first.raw as RunResult).status).toBe("finished")

    await session.prompt("again")
    // One create with the passthrough options; both sends on that same agent.
    expect(created).toHaveLength(1)
    expect(created[0]?.options.model).toEqual({ id: "composer-2.5" })
    expect(created[0]?.options.local).toEqual({ cwd: CWD })
    expect(sends.map((s) => s.message)).toEqual(["hello", "again"])

    const ref = await session.serialize()
    expect(decodeRef(ref)).toBe(AGENT_A)
  })

  test("serialize works before the first turn (agentId is minted at create)", async () => {
    const { client } = fakeClient({})
    const session = await createCursorHarness(client).createSession({ cwd: CWD, model: "composer-2.5" })
    expect(decodeRef(await session.serialize())).toBe(AGENT_A)
    await session.dispose()
  })

  test("error outcomes fail loudly with the raw result attached", async () => {
    for (const results of [
      [{ status: "error", error: { message: "backend exploded" }, result: undefined }],
      [{ status: "cancelled" }],
      [{ result: "" }],
    ]) {
      const { client } = fakeClient({ results: results as Partial<RunResult>[] })
      const session = await createCursorHarness(client).createSession({ cwd: CWD, model: "composer-2.5" })
      try {
        await session.prompt("hello")
        expect.unreachable()
      } catch (err) {
        expect(err).toBeInstanceOf(YokeError)
        expect((err as YokeError).raw).not.toBeNull()
      }
    }
  })

  test("dispose releases the agent exactly once", async () => {
    const { client, closeCount } = fakeClient({})
    const harness = createCursorHarness(client)
    const session = await harness.createSession({ cwd: CWD, model: "composer-2.5" })
    await session.dispose()
    await session.dispose()
    expect(closeCount()).toBe(1)
  })
})

describe("cursor harness resume + gate contract", () => {
  test("resume decodes the ref and passes the same options; unknown ids fail loudly", async () => {
    const ok = fakeClient({})
    const resumed = await createCursorHarness(ok.client).createSession({
      cwd: CWD,
      model: "composer-2.5",
      sessionRef: encodeRef(AGENT_B),
    })
    expect(ok.resumed[0]?.agentId).toBe(AGENT_B)
    expect(ok.resumed[0]?.options?.model).toEqual({ id: "composer-2.5" })
    await resumed.dispose()

    const unknown = fakeClient({ failResume: new Error("Agent not found") })
    await expect(
      createCursorHarness(unknown.client).createSession({
        cwd: CWD,
        model: "composer-2.5",
        sessionRef: encodeRef(AGENT_B),
      }),
    ).rejects.toThrow(YokeError)

    await expect(
      createCursorHarness(fakeClient().client).createSession({
        cwd: CWD,
        model: "composer-2.5",
        sessionRef: sessionRef("garbage"),
      }),
    ).rejects.toThrow(YokeError)
  })

  test("gate contract through the real adapter: busy, serialize, dispose-mid-turn", async () => {
    const { client, closeCount } = fakeClient({ mode: "hang", results: [{ result: "done" }] })
    const harness = createCursorHarness(client)

    const handle = await harness.createSession({ cwd: CWD, model: "composer-2.5" })
    const slowTurn = handle.prompt("SLOW")
    await new Promise((r) => setTimeout(r, 20))
    await expect(handle.prompt("again")).rejects.toBeInstanceOf(HandleBusyError)
    await expect(handle.serialize()).rejects.toBeInstanceOf(HandleBusyError)

    // Dispose cancels the in-flight run (wait resolves cancelled)...
    await handle.dispose()
    await expect(slowTurn).rejects.toBeInstanceOf(TurnAbortedError)
    await expect(handle.prompt("after dispose")).rejects.toBeInstanceOf(HandleDisposedError)
    expect(closeCount()).toBe(1)
  })

  test("abort during a hung turn rejects it as aborted", async () => {
    const { client } = fakeClient({ mode: "hang", results: [{ result: "ignored" }] })
    const harness = createCursorHarness(client)
    const session = await harness.createSession({ cwd: CWD, model: "composer-2.5" })
    const slowTurn = session.prompt("slow")
    await new Promise((r) => setTimeout(r, 20))
    await session.abort()
    await expect(slowTurn).rejects.toBeInstanceOf(TurnAbortedError)
    // The handle survives abort; dispose still works.
    await session.dispose()
  })

  test("resuming transfers ownership away from the old handle", async () => {
    const { client } = fakeClient({})
    const harness = createCursorHarness(client)
    const owner1 = await harness.createSession({ cwd: CWD, model: "composer-2.5" })
    const ref = await owner1.serialize()
    const owner2 = await harness.createSession({ cwd: CWD, model: "composer-2.5", sessionRef: ref })
    await expect(owner1.prompt("stale")).rejects.toBeInstanceOf(HandleBusyError)
    await owner2.dispose()
  })
})

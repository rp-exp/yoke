import { describe, expect, test } from "bun:test"
import type { OpenCodeLike } from "../src/adapters/opencode/client-like.ts"
import { createOpenCodeHarness } from "../src/adapters/opencode/backend.ts"
import { decodeRef, encodeRef } from "../src/adapters/opencode/ref.ts"
import {
  HandleBusyError,
  HandleDisposedError,
  TurnAbortedError,
  YokeError,
} from "../src/errors.ts"
import { sessionRef } from "../src/types.ts"
import type { SessionInfo, SessionMessageAssistant } from "@opencode-ai/client"

const CWD = process.cwd()

function sessionInfo(id: string, outcome?: SessionInfo["outcome"]): SessionInfo {
  return {
    id,
    projectID: "proj-test",
    cost: 0 as never,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } as never,
    time: { created: 0, updated: 0 },
    location: { directory: CWD },
    ...(outcome !== undefined ? { outcome } : {}),
  }
}

function assistantMessage(text: string): SessionMessageAssistant {
  return {
    id: "msg_assistant_1",
    type: "assistant",
    agent: "build",
    model: { id: "test-model", providerID: "opencode" } as never,
    content: [{ type: "text", text }],
    time: { created: 0 },
  }
}

type WaitMode = "instant" | "hang"

/**
 * Scripted OpenCode client. In "hang" mode `wait` blocks until interrupt() —
 * simulating a turn in flight so busy/abort paths can be driven deterministically.
 */
function fakeClient(config: {
  readonly outcome?: SessionInfo["outcome"]
  readonly assistantText?: string
  readonly waitMode?: WaitMode
  readonly getSessionFails?: boolean
} = {}) {
  const calls: string[] = []
  let interrupted = false
  let releaseWait: (() => void) | null = null

  const client: OpenCodeLike = {
    session: {
      create: async (input) => {
        calls.push("create")
        return sessionInfo("ses_new123", undefined)
      },
      get: async () => {
        calls.push("get")
        if (config.getSessionFails) throw new Error("404 not found")
        return sessionInfo("ses_existing1", interrupted ? "interrupted" : (config.outcome ?? undefined))
      },
      prompt: async (input) => {
        calls.push(`prompt:${input.text}`)
        return { id: "inb_1" } as never
      },
      wait: async () => {
        calls.push("wait")
        if ((config.waitMode ?? "instant") === "hang") {
          await new Promise<void>((resolve) => {
            releaseWait = resolve
          })
        }
        return
      },
      interrupt: async () => {
        calls.push("interrupt")
        interrupted = true
        releaseWait?.()
      },
    },
    message: {
      list: async () => {
        calls.push("messages")
        const text = config.assistantText ?? ""
        return { data: text === "" ? [] : [assistantMessage(text)], cursor: {} } as never
      },
    },
  }
  return { client, calls, get interrupted() { return interrupted } }
}

describe("opencode ref codec", () => {
  test("round-trips a session id", () => {
    expect(decodeRef(encodeRef("ses_abc123"))).toBe("ses_abc123")
  })

  test("rejects foreign and malformed refs loudly", () => {
    expect(() => decodeRef(sessionRef("claude-code:v1:ses_abc"))).toThrow(YokeError)
    expect(() => decodeRef(sessionRef("opencode:v1:not-a-session"))).toThrow(YokeError)
    expect(() => decodeRef(sessionRef(""))).toThrow(YokeError)
  })
})

describe("opencode harness turns", () => {
  test("prompt → wait → read assistant text", async () => {
    const { client, calls } = fakeClient({ outcome: "succeeded", assistantText: "ok" })
    const harness = createOpenCodeHarness(client)
    const session = await harness.createSession({ cwd: CWD })
    const result = await session.prompt("hello")
    expect(result.text).toBe("ok")
    expect(result.raw).not.toBeNull()
    expect(calls.filter((c) => c.startsWith("prompt:"))).toEqual(["prompt:hello"])
  })

  test("failed outcome rejects with yoke error carrying the raw info", async () => {
    const { client } = fakeClient({ outcome: "failed" })
    const harness = createOpenCodeHarness(client)
    const session = await harness.createSession({ cwd: CWD })
    try {
      await session.prompt("hello")
      expect.unreachable()
    } catch (err) {
      expect(err).toBeInstanceOf(YokeError)
      expect((err as YokeError).raw).not.toBeNull()
    }
  })

  test("interrupted outcome surfaces as TurnAbortedError", async () => {
    const { client } = fakeClient({ outcome: "interrupted", assistantText: "partial" })
    const harness = createOpenCodeHarness(client)
    const session = await harness.createSession({ cwd: CWD })
    await expect(session.prompt("hello")).rejects.toBeInstanceOf(TurnAbortedError)
  })

  test("a turn with no assistant text fails loudly (boundary validation)", async () => {
    const { client } = fakeClient({ outcome: "succeeded" })
    const harness = createOpenCodeHarness(client)
    const session = await harness.createSession({ cwd: CWD })
    await expect(session.prompt("hello")).rejects.toThrow("without assistant text")
  })

  test("server-side abort mid-turn becomes TurnAbortedError", async () => {
    const { client } = fakeClient({ waitMode: "hang", assistantText: "ignored" })
    const harness = createOpenCodeHarness(client)
    const session = await harness.createSession({ cwd: CWD })
    const turn = session.prompt("slow")
    await new Promise((r) => setTimeout(r, 20))
    await session.abort()
    await expect(turn).rejects.toBeInstanceOf(TurnAbortedError)
  })
})

describe("opencode model passthrough", () => {
  test("model string reaches the server as provider/model", async () => {
    let createdWith: unknown
    const { client } = fakeClient({})
    const patched: OpenCodeLike = {
      ...client,
      session: {
        ...client.session,
        create: async (input) => {
          createdWith = input
          return client.session.create(input)
        },
      },
    }
    const harness = createOpenCodeHarness(patched)
    const session = await harness.createSession({ cwd: CWD, model: "opencode-go/kimi-k3" })
    await session.dispose()
    expect(createdWith).toEqual({
      location: { directory: CWD },
      model: { providerID: "opencode-go", id: "kimi-k3" },
    })
  })

  test("malformed model strings fail loudly without a network call", async () => {
    const { client, calls } = fakeClient({})
    const harness = createOpenCodeHarness(client)
    await expect(harness.createSession({ cwd: CWD, model: "no-slash" })).rejects.toThrow(
      /providerID\/modelID/,
    )
    await expect(harness.createSession({ cwd: CWD, model: "/leading" })).rejects.toThrow(YokeError)
    expect(calls).not.toContain("create")
  })

  test("effort rides along as the model variant", async () => {
    let createdWith: unknown
    const { client } = fakeClient({})
    const patched: OpenCodeLike = {
      ...client,
      session: {
        ...client.session,
        create: async (input) => {
          createdWith = input
          return client.session.create(input)
        },
      },
    }
    const harness = createOpenCodeHarness(patched)
    const session = await harness.createSession({ cwd: CWD, model: "xai/grok-4.6", effort: "high" })
    await session.dispose()
    expect(createdWith).toEqual({
      location: { directory: CWD },
      model: { providerID: "xai", id: "grok-4.6", variant: "high" },
    })
  })

  test("effort without an explicit model fails loudly", async () => {
    const { client, calls } = fakeClient({})
    const harness = createOpenCodeHarness(client)
    await expect(harness.createSession({ cwd: CWD, effort: "high" })).rejects.toThrow(/requires an explicit/)
    expect(calls).not.toContain("create")
  })
})

describe("opencode harness resume + gate contract", () => {
  test("resume validates the session exists; unknown refs fail loudly", async () => {
    const ok = fakeClient({})
    const harnessOk = createOpenCodeHarness(ok.client)
    const resumed = await harnessOk.createSession({ cwd: CWD, sessionRef: encodeRef("ses_existing1") })
    await resumed.dispose()

    const missing = fakeClient({ getSessionFails: true })
    const harnessMissing = createOpenCodeHarness(missing.client)
    await expect(
      harnessMissing.createSession({ cwd: CWD, sessionRef: encodeRef("ses_missing0") }),
    ).rejects.toThrow(/no live session/)

    const garbage = createOpenCodeHarness(fakeClient({}).client)
    await expect(
      garbage.createSession({ cwd: CWD, sessionRef: sessionRef("totally:bogus") }),
    ).rejects.toThrow(YokeError)
  })

  test("gate contract through the real adapter: busy, serialize, dispose, ownership", async () => {
    const { client } = fakeClient({ waitMode: "hang", assistantText: "done" })
    const harness = createOpenCodeHarness(client)

    // Concurrent prompt and mid-turn serialize are rejected.
    const first = await harness.createSession({ cwd: CWD })
    const slowTurn = first.prompt("SLOW")
    await new Promise((r) => setTimeout(r, 20))
    await expect(first.prompt("again")).rejects.toBeInstanceOf(HandleBusyError)
    await expect(first.serialize()).rejects.toBeInstanceOf(HandleBusyError)

    // Dispose cancels the in-flight turn, then later prompts are rejected.
    await first.dispose()
    await expect(slowTurn).rejects.toBeInstanceOf(TurnAbortedError)
    await expect(first.prompt("after dispose")).rejects.toBeInstanceOf(HandleDisposedError)

    // Resuming transfers ownership away from the old handle.
    const owner1 = await harness.createSession({ cwd: CWD })
    const ref = await owner1.serialize()
    const owner2 = await harness.createSession({ cwd: CWD, sessionRef: ref })
    await expect(owner1.prompt("stale")).rejects.toBeInstanceOf(HandleBusyError)
    await owner2.dispose()
  })

  test("dispose does not remove the server-side session", async () => {
    const { client, calls } = fakeClient({})
    const harness = createOpenCodeHarness(client)
    const session = await harness.createSession({ cwd: CWD })
    const ref = await session.serialize()
    await session.dispose()
    expect(calls).not.toContain("remove")
    expect(decodeRef(ref)).toBe("ses_new123")
  })
})

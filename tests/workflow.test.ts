import { describe, expect, test } from "bun:test"
import { z } from "zod"
import { YokeError } from "../src/errors.ts"
import {
  extractJson,
  fakeAgent,
  isTransientTurnFailure,
  retryBackoffMs,
  TurnTimeoutError,
} from "../src/workflow.ts"
import { permanentFailure, silent, transientFailure } from "./fake-subject.ts"

const Reply = z.object({ ok: z.boolean() })

describe("boundary parsing", () => {
  test("extracts bare, fenced, and prose-wrapped JSON", () => {
    expect(extractJson('{"ok":true}')).toEqual({ ok: true })
    expect(extractJson('```json\n{"ok":true}\n```')).toEqual({ ok: true })
    expect(extractJson('Sure!\n{"ok":true}')).toEqual({ ok: true })
  })

  test("rejects a reply without JSON loudly", () => {
    expect(() => extractJson("no json here")).toThrow(/no JSON/)
  })
})

describe("failure vocabulary", () => {
  test("classifies real provider errors", () => {
    expect(isTransientTurnFailure(transientFailure())).toBe(true)
    // A turn that outlived its timeout was aborted mid-flight — overload-shaped.
    expect(isTransientTurnFailure(new TurnTimeoutError(50))).toBe(true)
    expect(isTransientTurnFailure(permanentFailure())).toBe(false)
    expect(isTransientTurnFailure(new Error("plain"))).toBe(false)
  })

  test("backoff grows exponentially and caps at two minutes", () => {
    expect(retryBackoffMs(1)).toBe(2_000)
    expect(retryBackoffMs(2)).toBe(8_000)
    expect(retryBackoffMs(3)).toBe(32_000)
    expect(retryBackoffMs(4)).toBe(120_000)
    expect(retryBackoffMs(9)).toBe(120_000)
  })
})

describe("ask — the reply contract", () => {
  test("states the schema's JSON shape in the prompt and returns the validated value", async () => {
    const prompts: string[] = []
    const echo = fakeAgent("echo", (prompt) => {
      prompts.push(prompt)
      return '{"ok":true}'
    })
    const value = await echo.open().ask("Do the thing.", Reply)
    expect(value).toEqual({ ok: true })
    expect(prompts[0]).toMatch(/^Do the thing\./)
    expect(prompts[0]).toContain("Reply with ONLY a JSON object matching exactly:")
    expect(prompts[0]).toContain('"ok"')
  })

  test("malformed reply is re-asked once on the same session", async () => {
    const prompts: string[] = []
    const flaky = fakeAgent("flaky", (prompt, call) => {
      prompts.push(prompt)
      return call === 1 ? "not json at all" : '{"ok":true}'
    })
    const value = await flaky.open().ask("Answer.", Reply, { onRetry: silent })
    expect(value).toEqual({ ok: true })
    expect(prompts).toHaveLength(2)
    expect(prompts[1]).toContain("refused")
  })

  test("schema issues name the offending field in the repair prompt", async () => {
    const prompts: string[] = []
    const wrongShape = fakeAgent("wrong-shape", (prompt, call) => {
      prompts.push(prompt)
      return call === 1 ? '{"ok":"yes"}' : '{"ok":true}'
    })
    await wrongShape.open().ask("Answer.", Reply, { onRetry: silent })
    expect(prompts[1]).toContain("ok:")
  })

  test("persistently malformed reply fails loud after the single repair", async () => {
    const bad = fakeAgent("bad", () => "still not json")
    await expect(bad.open().ask("Answer.", Reply, { onRetry: silent })).rejects.toThrow(/no JSON/)
  })
})

describe("retry policy", () => {
  test("default policy fails fast on the first harness failure", async () => {
    let calls = 0
    const flaky = fakeAgent("flaky", () => {
      calls += 1
      throw transientFailure()
    })
    await expect(flaky.open().run("go")).rejects.toThrow(YokeError)
    expect(calls).toBe(1)
  })

  test("transient policy retries on fresh sessions until attempts run out", async () => {
    let calls = 0
    const flaky = fakeAgent("flaky-provider", () => {
      calls += 1
      throw transientFailure()
    })
    const run = flaky.open().run("go", { retries: "transient", backoffMs: () => 0, onRetry: silent })
    await expect(run).rejects.toThrow(YokeError)
    expect(calls).toBe(5)
  })

  test("recovers when a later attempt succeeds; retries are numbered", async () => {
    const retries: string[] = []
    const flaky = fakeAgent("flaky-provider", (_prompt, call) => {
      if (call <= 2) throw transientFailure()
      return "done"
    })
    const reply = await flaky
      .open()
      .run("go", { retries: "transient", backoffMs: () => 0, onRetry: (message) => retries.push(message) })
    expect(reply).toBe("done")
    expect(retries).toHaveLength(2)
    expect(retries[0]).toMatch(/attempt 2\/5/)
    expect(retries[1]).toMatch(/attempt 3\/5/)
  })

  test("permanent failures never retry, even under the transient policy", async () => {
    let calls = 0
    const blocked = fakeAgent("policy-blocked", () => {
      calls += 1
      throw permanentFailure()
    })
    const run = blocked.open().run("go", { retries: "transient", backoffMs: () => 0, onRetry: silent })
    await expect(run).rejects.toThrow(/turn failed/)
    expect(calls).toBe(1)
  })

  test("policy declared on the agent applies to every turn without call-site options", async () => {
    const flaky = fakeAgent(
      "flaky",
      (_prompt, call) => {
        if (call === 1) throw transientFailure()
        return "done"
      },
      { retries: "transient" },
    )
    const reply = await flaky.open().run("go", { backoffMs: () => 0, onRetry: silent })
    expect(reply).toBe("done")
  })

  test("retries log loudly when the caller supplies no onRetry", async () => {
    const logged: string[] = []
    const original = console.error
    console.error = (message: string) => {
      logged.push(message)
    }
    try {
      const flaky = fakeAgent("flaky-provider", (_prompt, call) => {
        if (call === 1) throw transientFailure()
        return "done"
      })
      await flaky.open().run("go", { retries: "transient", backoffMs: () => 0 })
    } finally {
      console.error = original
    }
    expect(logged).toHaveLength(1)
    expect(logged[0]).toMatch(/attempt 2\/5/)
    expect(logged[0]).toMatch(/transient harness failure/)
  })
})

describe("timeouts", () => {
  test("hung turn under the default policy fails fast with TurnTimeoutError", async () => {
    const hung = fakeAgent("hung", () => new Promise<string>(() => {}))
    await expect(hung.open().run("go", { timeoutMs: 20 })).rejects.toThrow(/timed out/)
  })

  test("hung turn under the transient policy retries on fresh sessions, then fails loud", async () => {
    let calls = 0
    const hung = fakeAgent("hung", () => {
      calls += 1
      return new Promise<string>(() => {})
    })
    const run = hung.open().run("go", { timeoutMs: 20, retries: "transient", backoffMs: () => 0, onRetry: silent })
    await expect(run).rejects.toThrow(TurnTimeoutError)
    expect(calls).toBe(5)
  })
})

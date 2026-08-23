import { describe, expect, test } from "bun:test"
import { AdapterNotInstalledError, HarnessUnavailableError, YokeError, open } from "../src/index.ts"
import { registerAdapter } from "../src/registry.ts"
import type { Harness } from "../src/types.ts"

const fakeHarness: Harness = { id: "claude-code", createSession: () => Promise.reject(new Error("unused")) }

describe("open()", () => {
  test("unregistered harness fails loudly, naming the harness", async () => {
    // "cursor" has no subpath entry yet, so nothing can have registered it.
    await expect(open("cursor")).rejects.toBeInstanceOf(AdapterNotInstalledError)
  })

  test("registered adapter resolves to its harness", async () => {
    let calls = 0
    registerAdapter("claude-code", async () => {
      calls++
      return fakeHarness
    })
    const harness = await open("claude-code")
    expect(harness.id).toBe("claude-code")
    expect(calls).toBe(1)
  })

  test("loader failure surfaces as HarnessUnavailableError with cause", async () => {
    registerAdapter("opencode", async () => {
      throw new Error("SDK exploded")
    })
    try {
      await open("opencode")
      expect.unreachable()
    } catch (err) {
      expect(err).toBeInstanceOf(HarnessUnavailableError)
      if (err instanceof YokeError) {
        expect(err.harnessId).toBe("opencode")
        expect(err.cause).toBeInstanceOf(Error)
      }
    }
  })

  test("double registration is a programming error", () => {
    expect(() => registerAdapter("claude-code", async () => fakeHarness)).toThrow(/already registered/)
  })
})

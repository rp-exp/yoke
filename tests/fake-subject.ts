import {
  HandleBusyError,
  HandleDisposedError,
  TurnAbortedError,
  YokeError,
} from "../src/errors.ts"
import type {
  ConformanceSubject,
  TierASubject,
  TierBSubject,
} from "../src/conformance/subject.ts"
import { sessionRef } from "../src/types.ts"
import type { Harness, SessionHandle, SessionOptions, SessionRef, TurnResult } from "../src/types.ts"

const HARNESS_ID = "opencode" as const

interface SessionState {
  history: string[]
  ownerId: symbol
  ref: SessionRef
  pending: ((cause: unknown) => void) | null
  disposed: boolean
}

export interface FakeSubjectOptions {
  /** Defaults to "A". */
  readonly tier?: "A" | "B"
  /**
   * When false, the fake skips its concurrency/ownership guards — simulating a
   * broken adapter so tests can assert the suite catches contract violations.
   */
  readonly enforceGuards?: boolean
}

/**
 * In-memory reference implementation of the yoke contract, used to prove the
 * conformance runner end to end without a live harness. Its "child process"
 * resume is simulated (fresh ownership, no OS process) — cross-process reality
 * is what real tier-A subjects must demonstrate themselves.
 */
export function makeFakeSubject(options: FakeSubjectOptions = {}): ConformanceSubject & { harness: Harness } {
  const guards = options.enforceGuards ?? true
  const sessions = new Map<SessionRef, SessionState>()
  let nextId = 0

  const freshOwnerId = () => Symbol(`handle-${++nextId}`)

  function replyFor(history: readonly string[], input: string): string {
    const remembered = [...history]
      .reverse()
      .map((entry) => /word: (\w+)/.exec(entry)?.[1])
      .find((word) => word !== undefined)
    if (input.includes("What word")) return remembered ?? "nothing"
    return "ok"
  }

  class FakeHandle implements SessionHandle {
    constructor(
      private readonly state: SessionState,
      private readonly ownerId: symbol,
    ) {}

    async prompt(input: string): Promise<TurnResult> {
      const { state } = this
      if (state.disposed) throw new HandleDisposedError(HARNESS_ID, "session is disposed")
      if (guards && state.ownerId !== this.ownerId) {
        throw new HandleBusyError(HARNESS_ID, "ownership transferred to another handle")
      }
      if (guards && state.pending !== null) {
        throw new HandleBusyError(HARNESS_ID, "turn already in flight")
      }

      if (input.startsWith("SLOW") && guards) {
        // A turn that stays in flight until aborted or timed out.
        await new Promise<void>((_resolve, reject) => {
          state.pending = (cause) => reject(cause)
          setTimeout(() => {
            if (state.pending === null) return
            state.pending = null
            _resolve()
          }, 400)
        })
        // Resolving means the turn finished on its own.
        state.history.push(input)
        return { text: replyFor(state.history, input), raw: { harness: HARNESS_ID } }
      }

      state.history.push(input)
      return {
        text: replyFor(state.history, input),
        raw: { harness: HARNESS_ID, turns: state.history.length },
      }
    }

    async serialize(): Promise<SessionRef> {
      if (this.state.disposed) throw new HandleDisposedError(HARNESS_ID, "session is disposed")
      if (guards && this.state.pending !== null) {
        throw new HandleBusyError(HARNESS_ID, "serialize mid-turn")
      }
      return this.state.ref
    }

    async abort(): Promise<void> {
      const pending = this.state.pending
      this.state.pending = null
      pending?.(new TurnAbortedError(HARNESS_ID, "turn aborted"))
    }

    async dispose(): Promise<void> {
      await this.abort() // disposing mid-turn cancels the turn first (DESIGN.md)
      this.state.disposed = true
    }
  }

  const harness: Harness = {
    id: HARNESS_ID,
    async createSession(opts: SessionOptions): Promise<SessionHandle> {
      if (opts.sessionRef !== undefined) {
        const state = sessions.get(opts.sessionRef)
        if (state === undefined || state.disposed) {
          throw new YokeError(HARNESS_ID, `no live session for ref ${JSON.stringify(opts.sessionRef)}`)
        }
        state.ownerId = freshOwnerId() // ownership transfers away from the old handle
        return new FakeHandle(state, state.ownerId)
      }
      const ref = sessionRef(`fake-ref-${++nextId}`)
      const ownerId = freshOwnerId()
      const state: SessionState = { history: [], ownerId, ref, pending: null, disposed: false }
      sessions.set(ref, state)
      return new FakeHandle(state, ownerId)
    },
  }

  const base = {
    harnessId: HARNESS_ID,
    slowPrompt: "SLOW: keep working for a while",
    open: async () => harness,
  }

  const tierB: TierBSubject = { ...base, tier: "B" }
  const tierA: TierASubject = {
    ...base,
    tier: "A",
    resumeInChildProcess: (ref: SessionRef, input: string): Promise<TurnResult> => {
      const state = sessions.get(ref)
      if (state === undefined) {
        return Promise.reject(new YokeError(HARNESS_ID, `no live session for ref ${JSON.stringify(ref)}`))
      }
      // Simulated child process: independent owner, no shared handle.
      return Promise.resolve({ text: replyFor(state.history, input), raw: { via: "simulated-child" } })
    },
  }

  const subject = options.tier === "B" ? tierB : tierA
  return { ...subject, harness }
}

// ---------------------------------------------------------------------------
// Shared workflow-test helpers — one copy so the transient vocabulary cannot
// drift between suites.

/** No-op retry logger so tests never touch console.error. */
export const silent = (): void => {}

/** Provider-shaped transient failure: worth repeating on a fresh session. */
export const transientFailure = (): YokeError =>
  new YokeError("opencode", "turn failed", {
    raw: {
      error: { type: "provider.invalid-output", message: "The provider response ended with an unknown finish reason." },
    },
  })

/** Policy-shaped permanent failure: retrying cannot succeed. */
export const permanentFailure = (): YokeError =>
  new YokeError("opencode", "turn failed", {
    raw: { error: { type: "provider.invalid-request", message: "No endpoints available" } },
  })

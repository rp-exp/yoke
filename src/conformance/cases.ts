import type { Harness, SessionHandle } from "../types.ts"
import {
  HandleBusyError,
  HandleDisposedError,
  TurnAbortedError,
  YokeError,
} from "../errors.ts"
import { sessionRef as brandRef } from "../types.ts"
import type { ConformanceSubject } from "./subject.ts"

export interface CaseContext {
  readonly subject: ConformanceSubject
  /** Opens a harness (once per case) to drive. */
  harness(): Promise<Harness>
}

interface ConformanceCase {
  readonly name: string
  /** "A" cases run only for tier-A subjects; others are reported skipped-tier. */
  readonly tier: "all" | "A"
  readonly run: (ctx: CaseContext) => Promise<void>
}

/** Test-double rejection assertion: fails the case unless the promise rejects with `errorClass`. */
async function expectRejection(p: Promise<unknown>, errorClass: typeof YokeError): Promise<void> {
  try {
    await p
  } catch (err) {
    if (err instanceof errorClass) return
    throw new Error(`rejected with ${String(err)}; expected ${errorClass.name}`)
  }
  throw new Error(`expected rejection with ${errorClass.name}, but resolved`)
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function newSession(ctx: CaseContext): Promise<{ harness: Harness; session: SessionHandle }> {
  const harness = await ctx.harness()
  const session = await harness.createSession({ cwd: process.cwd() })
  return { harness, session }
}

/** Starts a slow turn and returns it once actually in flight; caller must clean up via abort(). */
async function startSlowTurn(
  ctx: CaseContext,
): Promise<{ session: SessionHandle; turn: Promise<unknown> }> {
  const { session } = await newSession(ctx)
  const turn = session.prompt(ctx.subject.slowPrompt)
  await sleep(200)
  return { session, turn }
}

/** Aborts a slow turn and awaits its contractual TurnAbortedError rejection. */
async function cleanupSlowTurn(session: SessionHandle, turn: Promise<unknown>): Promise<void> {
  const aborted = expectRejection(turn, TurnAbortedError)
  await session.abort()
  await aborted
}

export const CONFORMANCE_CASES: readonly ConformanceCase[] = [
  // --- Session lifecycle -------------------------------------------------
  {
    name: "createSession resolves to a handle",
    tier: "all",
    run: async (ctx) => {
      const { session } = await newSession(ctx)
      await session.dispose()
    },
  },
  {
    name: "prompt resolves with non-empty text and raw present",
    tier: "all",
    run: async (ctx) => {
      const { session } = await newSession(ctx)
      const result = await session.prompt("Reply with exactly: ok")
      if (typeof result.text !== "string" || result.text.length === 0) {
        throw new Error(`expected non-empty text, got ${JSON.stringify(result.text)}`)
      }
      if (result.raw === undefined) throw new Error("expected raw to be present")
      await session.dispose()
    },
  },
  {
    name: "serialize returns an opaque ref",
    tier: "all",
    run: async (ctx) => {
      const { session } = await newSession(ctx)
      const ref = await session.serialize()
      if (typeof ref !== "string" || ref.length === 0) throw new Error("expected non-empty ref")
      await session.dispose()
    },
  },

  // --- Failure contract --------------------------------------------------
  {
    name: "second concurrent prompt rejects with HandleBusyError",
    tier: "all",
    run: async (ctx) => {
      const { session, turn } = await startSlowTurn(ctx)
      try {
        await expectRejection(session.prompt("another prompt"), HandleBusyError)
      } finally {
        await cleanupSlowTurn(session, turn)
        await session.dispose()
      }
    },
  },
  {
    name: "serialize mid-turn rejects with HandleBusyError",
    tier: "all",
    run: async (ctx) => {
      const { session, turn } = await startSlowTurn(ctx)
      try {
        await expectRejection(session.serialize(), HandleBusyError)
      } finally {
        await cleanupSlowTurn(session, turn)
        await session.dispose()
      }
    },
  },
  {
    name: "abort makes in-flight prompt reject with TurnAbortedError",
    tier: "all",
    run: async (ctx) => {
      const { session, turn } = await startSlowTurn(ctx)
      await cleanupSlowTurn(session, turn)
      await session.dispose()
    },
  },
  {
    name: "prompt after dispose rejects with HandleDisposedError",
    tier: "all",
    run: async (ctx) => {
      const { session } = await newSession(ctx)
      await session.dispose()
      await expectRejection(session.prompt("hi"), HandleDisposedError)
    },
  },
  {
    name: "dispose is idempotent",
    tier: "all",
    run: async (ctx) => {
      const { session } = await newSession(ctx)
      await session.dispose()
      await session.dispose()
    },
  },

  // --- Resume (tier A only) ----------------------------------------------
  {
    name: "resumed session carries prior context",
    tier: "A",
    run: async (ctx) => {
      const { harness, session } = await newSession(ctx)
      await session.prompt("Remember this word: BANANA. Reply with exactly: ok")
      const ref = await session.serialize()
      const resumed = await harness.createSession({ cwd: process.cwd(), sessionRef: ref })
      const answer = await resumed.prompt("What word were you told to remember? Reply with only that word.")
      if (!answer.text.toUpperCase().includes("BANANA")) {
        throw new Error(`resumed session lost context; got ${JSON.stringify(answer.text)}`)
      }
      await resumed.dispose()
    },
  },
  {
    name: "old handle loses ownership after resume",
    tier: "A",
    run: async (ctx) => {
      const { harness, session } = await newSession(ctx)
      const ref = await session.serialize()
      const resumed = await harness.createSession({ cwd: process.cwd(), sessionRef: ref })
      await expectRejection(session.prompt("hi"), HandleBusyError)
      await resumed.dispose()
    },
  },
  {
    name: "garbage ref fails loudly instead of starting fresh",
    tier: "A",
    run: async (ctx) => {
      const harness = await ctx.harness()
      const garbage = brandRef("yoke-conformance-nonexistent-ref")
      await expectRejection(harness.createSession({ cwd: process.cwd(), sessionRef: garbage }), YokeError)
    },
  },
  {
    name: "ref resumes across processes",
    tier: "A",
    run: async (ctx) => {
      const subject = ctx.subject
      if (subject.tier !== "A") throw new Error("unreachable: runner narrows tier before running A cases")
      const { session } = await newSession(ctx)
      await session.prompt("Remember this word: CHERRY. Reply with exactly: ok")
      const ref = await session.serialize()
      const answer = await subject.resumeInChildProcess(
        ref,
        "What word were you told to remember? Reply with only that word.",
      )
      if (!answer.text.toUpperCase().includes("CHERRY")) {
        throw new Error(`child-process resume lost context; got ${JSON.stringify(answer.text)}`)
      }
    },
  },
]

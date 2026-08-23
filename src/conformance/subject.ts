import type { Harness, HarnessId, SessionRef, TurnResult } from "../types.ts"

interface SubjectBase {
  readonly harnessId: HarnessId
  /**
   * An instruction whose turn reliably stays in flight for several seconds,
   * giving the suite a window to issue competing calls. Per-harness phrasing;
   * e.g. "Run `sleep 10` in the shell."
   */
  readonly slowPrompt: string
  /**
   * Opens the harness. Must throw loudly if the harness is unreachable or
   * unauthenticated — the suite never skips silently (CONFORMANCE.md).
   */
  open(): Promise<Harness>
}

/** Subject declaring tier B: refs are valid only within the orchestrator process. */
export interface TierBSubject extends SubjectBase {
  readonly tier: "B"
}

/** Subject declaring tier A: refs resume across processes, and the subject can prove it. */
export interface TierASubject extends SubjectBase {
  readonly tier: "A"
  /** Resumes the ref inside a freshly spawned child process on the same machine. */
  resumeInChildProcess(ref: SessionRef, input: string): Promise<TurnResult>
}

export type ConformanceSubject = TierASubject | TierBSubject

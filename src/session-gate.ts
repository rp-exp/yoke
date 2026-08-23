import type { HarnessId, SessionHandle, SessionRef, TurnResult } from "./types.ts"
import {
  HandleBusyError,
  HandleDisposedError,
  TurnAbortedError,
  YokeError,
} from "./errors.ts"

/**
 * Per-harness operations a gate drives. The backend knows nothing about the
 * busy/ownership/disposal contract — the gate owns all of it, once, for every
 * adapter (mirroring tests/fake-subject.ts, which pins these semantics).
 */
export interface TurnBackend {
  readonly harnessId: HarnessId
  /** Stable identity of the underlying session; safe to hand out via serialize(). */
  readonly ref: SessionRef
  /** Runs one turn to completion. Must already throw yoke errors for failures. */
  startTurn(input: string): Promise<TurnResult>
  /** Cancels the in-flight turn started by startTurn. */
  abortTurn(): Promise<void>
}

/**
 * Ownership registry: resuming a ref transfers it away from any existing
 * in-process handle (DESIGN.md "Resuming transfers ownership").
 */
const currentOwners = new Map<string, symbol>()

export class SessionGate implements SessionHandle {
  private disposed = false
  private inFlight: Promise<unknown> | null = null
  private abortRequested = false
  private readonly ownerId: symbol

  constructor(private readonly backend: TurnBackend) {
    this.ownerId = Symbol(backend.ref)
    currentOwners.set(backend.ref, this.ownerId)
  }

  async prompt(input: string): Promise<TurnResult> {
    this.assertPromptable()
    this.abortRequested = false
    const turn = this.backend.startTurn(input)
    this.inFlight = turn
    try {
      return await turn
    } catch (err) {
      // An abort request that coincided with a *successful* completion still
      // yields the full result: discarding finished work helps nobody.
      if (this.abortRequested && !(err instanceof TurnAbortedError)) {
        throw new TurnAbortedError(this.id, "turn aborted", { cause: err })
      }
      throw err instanceof YokeError ? err : new YokeError(this.id, String(err), { cause: err })
    } finally {
      this.inFlight = null
      this.abortRequested = false
    }
  }

  async serialize(): Promise<SessionRef> {
    if (this.disposed) throw new HandleDisposedError(this.id, "session is disposed")
    if (this.inFlight !== null) throw new HandleBusyError(this.id, "serialize mid-turn")
    return this.backend.ref
  }

  async abort(): Promise<void> {
    if (this.disposed || this.inFlight === null) return
    this.abortRequested = true
    await this.backend.abortTurn()
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    if (this.inFlight !== null) {
      // Disposing mid-turn cancels the turn first (DESIGN.md).
      this.abortRequested = true
      const turn = this.inFlight
      await this.backend.abortTurn()
      try {
        await turn
      } catch (err) {
        if (!(err instanceof TurnAbortedError)) throw err
      }
    }
    this.disposed = true
  }

  private get id(): HarnessId {
    return this.backend.harnessId
  }

  private assertPromptable(): void {
    if (this.disposed) throw new HandleDisposedError(this.id, "session is disposed")
    if (currentOwners.get(this.backend.ref) !== this.ownerId) {
      throw new HandleBusyError(this.id, "ownership transferred to another handle")
    }
    if (this.inFlight !== null) throw new HandleBusyError(this.id, "turn already in flight")
  }
}

import type { HarnessId } from "./types.ts"

/** Root of the yoke error hierarchy, so workflows can catch broadly or narrowly. */
export class YokeError extends Error {
  readonly harnessId: HarnessId
  /** Harness-native error object; same escape hatch as TurnResult.raw. */
  readonly raw: unknown

  constructor(harnessId: HarnessId, message: string, options?: { cause?: unknown; raw?: unknown }) {
    super(message, { cause: options?.cause })
    this.name = new.target.name
    this.harnessId = harnessId
    this.raw = options?.raw ?? null
  }
}

/** abort() landed during this turn. */
export class TurnAbortedError extends YokeError {}

/** Concurrent prompt(), mid-turn serialize(), or prompting a handle that lost ownership. */
export class HandleBusyError extends YokeError {}

/** prompt() after dispose(). */
export class HandleDisposedError extends YokeError {}

/** Spawning/connecting to the harness failed. */
export class HarnessUnavailableError extends YokeError {}

/** The harness SDK backing an adapter is not installed; message names what to install. */
export class AdapterNotInstalledError extends YokeError {}

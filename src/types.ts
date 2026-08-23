declare const refBrand: unique symbol

/** Grows as adapters land. MVP covers these three; Codex and Pi are deferred. */
export type HarnessId = "opencode" | "claude-code" | "cursor"

/** Opaque token. Persist verbatim, pass back verbatim; parsing it is unsupported. */
export type SessionRef = string & { readonly [refBrand]: never }

export function sessionRef(value: string): SessionRef {
  return value as SessionRef
}

export interface SessionOptions {
  cwd: string
  /** Pass a ref from serialize() to resume instead of starting fresh. */
  sessionRef?: SessionRef | undefined
}

export interface TurnResult {
  /** Final assistant message. */
  text: string
  /** Harness-native result, escape hatch. */
  raw: unknown
}

export interface SessionHandle {
  /** Send a prompt; resolves when the agent finishes the turn. */
  prompt(input: string): Promise<TurnResult>
  /** Round-trip into createSession({ sessionRef }) to resume. */
  serialize(): Promise<SessionRef>
  abort(): Promise<void>
  dispose(): Promise<void>
}

export interface Harness {
  readonly id: HarnessId
  createSession(opts: SessionOptions): Promise<SessionHandle>
}

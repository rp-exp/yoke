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
  /**
   * Opaque model string in the harness's native vocabulary (e.g. "provider/model").
   * Pass-through only — never a registry; omit to use the harness's own default.
   */
  model?: string | undefined
  /**
   * Opaque reasoning-effort string (e.g. "high"), same contract as `model`:
   * verbatim pass-through, mapped to each harness's native knob (claude-code:
   * native option; opencode: model variant). Harnesses with no equivalent
   * reject it loudly instead of guessing.
   */
  effort?: string | undefined
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

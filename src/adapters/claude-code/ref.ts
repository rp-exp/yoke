import type { SessionRef } from "../../types.ts"
import { sessionRef } from "../../types.ts"
import { YokeError } from "../../errors.ts"

/**
 * Ref format: `claude-code:v1:<uuid>`. Opaque to workflows; only this adapter
 * decodes it. Sessions persist as JSONL under ~/.claude, so the ref is valid
 * across processes on the same machine (tier A) for as long as the JSONL exists.
 */
const PREFIX = "claude-code:v1:"
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Validates a session UUID at the boundary (server responses, ref payloads). */
export function assertSessionUUID(value: string): string {
  if (!UUID_PATTERN.test(value)) {
    throw new YokeError("claude-code", `malformed session id ${JSON.stringify(value)}`, { raw: value })
  }
  return value
}

export function encodeRef(sessionId: string): SessionRef {
  assertSessionUUID(sessionId)
  return sessionRef(`${PREFIX}${sessionId}`)
}

export function decodeRef(ref: SessionRef): string {
  if (!ref.startsWith(PREFIX)) {
    throw new YokeError("claude-code", `ref does not belong to the claude-code adapter: ${JSON.stringify(ref)}`)
  }
  return assertSessionUUID(ref.slice(PREFIX.length))
}

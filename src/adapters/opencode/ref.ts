import type { SessionRef } from "../../types.ts"
import { sessionRef } from "../../types.ts"
import { YokeError } from "../../errors.ts"

/**
 * Ref format: `opencode:v1:<sessionID>`. Opaque to workflows; only this
 * adapter ever decodes it. The service owns sessions, so the ref is durable
 * across processes (tier A) — it's just an ID, valid as long as the service
 * still has the session.
 */
const PREFIX = "opencode:v1:"
const SESSION_ID_PATTERN = /^ses[a-z0-9_-]+$/i

/** Validates a sessionID returned by the server (boundary validation). */
export function assertSessionID(value: string): string {
  if (!SESSION_ID_PATTERN.test(value)) {
    throw new YokeError("opencode", `server returned malformed session id ${JSON.stringify(value)}`, { raw: value })
  }
  return value
}

export function encodeRef(sessionID: string): SessionRef {
  assertSessionID(sessionID)
  return sessionRef(`${PREFIX}${sessionID}`)
}

export function decodeRef(ref: SessionRef): string {
  if (!ref.startsWith(PREFIX)) {
    throw new YokeError("opencode", `ref does not belong to the opencode adapter: ${JSON.stringify(ref)}`)
  }
  const id = ref.slice(PREFIX.length)
  if (!SESSION_ID_PATTERN.test(id)) {
    throw new YokeError("opencode", `ref carries malformed session id: ${JSON.stringify(ref)}`)
  }
  return id
}

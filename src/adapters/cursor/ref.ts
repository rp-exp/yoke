import type { SessionRef } from "../../types.ts"
import { sessionRef } from "../../types.ts"
import { YokeError } from "../../errors.ts"

/**
 * Ref format: `cursor:v1:<agentId>`. Opaque to workflows; only this adapter
 * decodes it. Local agents persist rows and conversation checkpoints in the
 * SDK's store under the workspace cwd, so the ref resumes across processes
 * (tier A) — including before the first turn, because the agent row exists
 * from creation time.
 */
const PREFIX = "cursor:v1:"
/** Agent ids are opaque tokens (local mints uuid-shaped ones, cloud uses `bc-…`). */
const ID_PATTERN = /^[A-Za-z0-9_-]+$/

export function assertAgentId(value: string): string {
  if (!ID_PATTERN.test(value)) {
    throw new YokeError("cursor", `malformed agent id ${JSON.stringify(value)}`, { raw: value })
  }
  return value
}

export function encodeRef(agentId: string): SessionRef {
  assertAgentId(agentId)
  return sessionRef(`${PREFIX}${agentId}`)
}

export function decodeRef(ref: SessionRef): string {
  if (!ref.startsWith(PREFIX)) {
    throw new YokeError("cursor", `ref does not belong to the cursor adapter: ${JSON.stringify(ref)}`)
  }
  return assertAgentId(ref.slice(PREFIX.length))
}

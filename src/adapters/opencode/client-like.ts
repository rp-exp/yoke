import type {
  SessionInfo,
  SessionInboxUser,
  SessionMessagesResponse,
} from "@opencode-ai/client"

/**
 * Narrow structural view of the generated OpenCode client — exactly the
 * operations the adapter uses. The full `OpenCodeClient` must be assignable
 * to this (asserted in backend.ts), which keeps unit-test fakes honest
 * against the real SDK shapes.
 */
export interface OpenCodeLike {
  readonly session: {
    readonly create: (input: {
      readonly location?: { readonly directory: string; readonly workspaceID?: string }
    }) => Promise<SessionInfo>
    readonly get: (input: { readonly sessionID: string }) => Promise<SessionInfo>
    readonly prompt: (input: { readonly sessionID: string; readonly text: string }) => Promise<SessionInboxUser>
    /** Long-poll; resolves once the session goes idle. */
    readonly wait: (input: { readonly sessionID: string }) => Promise<void>
    readonly interrupt: (input: { readonly sessionID: string }) => Promise<void>
  }
  readonly message: {
    readonly list: (input: {
      readonly sessionID: string
      readonly order?: "asc" | "desc"
      readonly limit?: number
    }) => Promise<SessionMessagesResponse>
  }
}

import type { OpenCodeClient } from "@opencode-ai/client"

type RealClientFits = OpenCodeClient extends OpenCodeLike ? true : never
const assertRealClientFits: RealClientFits = true
void assertRealClientFits

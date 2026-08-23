import type { Options, SDKMessage } from "@anthropic-ai/claude-agent-sdk"

/**
 * Narrow structural view of the Claude Code Agent SDK — exactly the surface
 * the adapter uses. The real SDK module namespace must be assignable to this
 * (asserted below), which keeps unit-test fakes honest against real shapes.
 */
export interface QueryLike extends AsyncIterable<SDKMessage> {
  /** Kills the CLI subprocess. After close(), iteration ends and no messages arrive. */
  readonly close: () => void
  /** Asks the CLI to stop the in-flight turn; may reject if the process is already gone. */
  readonly interrupt: () => Promise<unknown>
}

export interface ClaudeCodeClientLike {
  query(params: {
    prompt: string | AsyncIterable<import("@anthropic-ai/claude-agent-sdk").SDKUserMessage>
    options?: Options
  }): QueryLike
}

import * as sdk from "@anthropic-ai/claude-agent-sdk"

type RealSdkFits = typeof sdk extends ClaudeCodeClientLike ? true : never
const assertRealSdkFits: RealSdkFits = true
void assertRealSdkFits

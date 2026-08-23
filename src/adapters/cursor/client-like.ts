import type { AgentOptions, RunResult, SDKAgent, SDKUserMessage, SendOptions } from "@cursor/sdk"

/**
 * Narrow structural views of the Cursor Agent SDK — exactly the surface the
 * adapter uses. Compile-time assertions below keep the fakes honest against
 * the real shapes.
 */

export interface CursorRunLike {
  readonly id: string
  /** Resolves with the terminal RunResult, including after cancel(). */
  wait(): Promise<RunResult>
  cancel(): Promise<void>
}

export interface CursorSdkAgentLike {
  readonly agentId: string
  send(message: string | SDKUserMessage, options?: SendOptions): Promise<CursorRunLike>
  /** Releases the local runtime/executor lease and drains analytics. */
  close(): void
}

export interface CursorAgentStaticLike {
  create(options: AgentOptions): Promise<CursorSdkAgentLike>
  /** Throws (UnknownAgentError) when no persisted agent exists for the id. */
  resume(agentId: string, options?: Partial<AgentOptions>): Promise<CursorSdkAgentLike>
}

export interface CursorClientLike {
  readonly agent: CursorAgentStaticLike
}

import * as sdk from "@cursor/sdk"

type RealAgentStaticFits = typeof sdk.Agent extends CursorAgentStaticLike ? true : never
const assertRealAgentStaticFits: RealAgentStaticFits = true
void assertRealAgentStaticFits

type RealRunFits = Awaited<ReturnType<(typeof sdk)["Agent"]["create"]>> extends CursorSdkAgentLike
  ? true
  : never
const assertRealRunFits: RealRunFits = true
void assertRealRunFits

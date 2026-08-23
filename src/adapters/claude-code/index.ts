import { AdapterNotInstalledError } from "../../errors.ts"
import { registerAdapter } from "../../registry.ts"
import type { Harness } from "../../types.ts"
import { createClaudeCodeHarness } from "./backend.ts"

/**
 * Entry point for the Claude Code adapter: `import "yoke/claude-code"`.
 * Importing this module registers the adapter; opening it lazily imports the
 * optional peer SDK. The subprocess shape needs no service management — each
 * turn spawns its own CLI process, so there is nothing to cache here beyond
 * the harness object itself.
 */

let cached: Promise<Harness> | null = null

registerAdapter("claude-code", () => {
  cached ??= openClaudeCode()
  return cached
})

async function openClaudeCode(): Promise<Harness> {
  let sdk: typeof import("@anthropic-ai/claude-agent-sdk")
  try {
    sdk = await import("@anthropic-ai/claude-agent-sdk")
  } catch (cause) {
    throw new AdapterNotInstalledError(
      "claude-code",
      'The Claude Code adapter needs "@anthropic-ai/claude-agent-sdk". Install it next to yoke.',
      { cause },
    )
  }
  return createClaudeCodeHarness(sdk)
}

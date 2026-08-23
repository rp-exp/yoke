import { AdapterNotInstalledError } from "../../errors.ts"
import { registerAdapter } from "../../registry.ts"
import type { Harness } from "../../types.ts"
import { createCursorHarness } from "./backend.ts"

/**
 * Entry point for the Cursor adapter: `import "yoke/cursor"`.
 * Importing this module registers the adapter; opening it lazily imports the
 * optional peer SDK. Local agents spawn their runtime on first send, so there
 * is nothing to discover or start here beyond building the harness object.
 */

let cached: Promise<Harness> | null = null

registerAdapter("cursor", () => {
  cached ??= openCursor()
  return cached
})

async function openCursor(): Promise<Harness> {
  let sdk: typeof import("@cursor/sdk")
  try {
    sdk = await import("@cursor/sdk")
  } catch (cause) {
    throw new AdapterNotInstalledError(
      "cursor",
      'The Cursor adapter needs "@cursor/sdk". Install it next to yoke.',
      { cause },
    )
  }
  return createCursorHarness({ agent: sdk.Agent })
}

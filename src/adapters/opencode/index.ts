import { AdapterNotInstalledError } from "../../errors.ts"
import { registerAdapter } from "../../registry.ts"

/**
 * Entry point for the OpenCode (V2) adapter: `import "yoke/opencode"`.
 * Importing this module registers the adapter with the core registry.
 *
 * Not implemented yet — the loader fails loudly rather than pretending to work.
 */

registerAdapter("opencode", async () => {
  throw new AdapterNotInstalledError(
    "opencode",
    'OpenCode adapter is not implemented yet; "@opencode-ai/client" is not wired up.',
  )
})

import { AdapterNotInstalledError, HarnessUnavailableError } from "./errors.ts"
import type { Harness, HarnessId } from "./types.ts"

/**
 * Internal registry seam. Adapters self-register via their subpath entry
 * (`yoke/<harness>`); `open()` resolves through it so a later split into
 * separate packages stays mechanical.
 */
const adapters = new Map<HarnessId, () => Promise<Harness>>()

export function registerAdapter(id: HarnessId, load: () => Promise<Harness>): void {
  if (adapters.has(id)) {
    throw new Error(`Adapter for "${id}" is already registered`)
  }
  adapters.set(id, load)
}

/** The peerDependency package that backs each adapter; named in install errors. */
const backingPackage: Record<HarnessId, string> = {
  "opencode": "@opencode-ai/client",
  "claude-code": "@anthropic-ai/claude-agent-sdk",
  "cursor": "@cursor/sdk",
}

export async function open(id: HarnessId): Promise<Harness> {
  const load = adapters.get(id)
  if (load === undefined) {
    throw new AdapterNotInstalledError(
      id,
      `No adapter registered for "${id}". Import "yoke/${id}" and ensure its SDK "${backingPackage[id]}" is installed.`,
    )
  }
  try {
    return await load()
  } catch (cause) {
    throw new HarnessUnavailableError(id, `Harness "${id}" could not be opened`, { cause })
  }
}

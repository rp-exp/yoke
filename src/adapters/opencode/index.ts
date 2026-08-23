import { AdapterNotInstalledError, HarnessUnavailableError } from "../../errors.ts"
import { registerAdapter } from "../../registry.ts"
import type { Harness } from "../../types.ts"
import { createOpenCodeHarness } from "./backend.ts"
import type { OpenCodeLike } from "./client-like.ts"

/**
 * Entry point for the OpenCode (V2) adapter: `import "yoke/opencode"`.
 * Importing this module registers the adapter; opening it lazily imports the
 * optional peer SDK, discovers or starts the shared background service, and
 * builds a client. The harness is cached so repeated open() calls reuse one
 * service connection.
 */

let cached: Promise<Harness> | null = null

registerAdapter("opencode", () => {
  cached ??= openOpenCode()
  return cached
})

async function importSdk(): Promise<{
  OpenCode: typeof import("@opencode-ai/client").OpenCode
  Service: typeof import("@opencode-ai/client/service").Service
}> {
  try {
    const [client, service] = await Promise.all([
      import("@opencode-ai/client"),
      import("@opencode-ai/client/service"),
    ])
    return { OpenCode: client.OpenCode, Service: service.Service }
  } catch (cause) {
    throw new AdapterNotInstalledError(
      "opencode",
      'The OpenCode adapter needs "@opencode-ai/client" (beta). Install it next to yoke.',
      { cause },
    )
  }
}

async function openOpenCode(): Promise<Harness> {
  const { OpenCode, Service } = await importSdk()
  try {
    // Discovers a healthy registered service or starts `opencode serve --service`.
    const endpoint = await Service.ensure()
    const client: OpenCodeLike = OpenCode.make({
      baseUrl: endpoint.url,
      headers: Service.headers(endpoint),
    })
    return createOpenCodeHarness(client)
  } catch (cause) {
    if (cause instanceof AdapterNotInstalledError) throw cause
    throw new HarnessUnavailableError(
      "opencode",
      "could not reach or start the OpenCode V2 background service",
      { cause },
    )
  }
}

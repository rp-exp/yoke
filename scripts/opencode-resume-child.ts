import { open } from "../src/registry.ts"
import { sessionRef } from "../src/types.ts"
import "../src/adapters/opencode/index.ts"

// Child process for the cross-process resume conformance case: resumes a ref
// in this fresh process, runs one prompt, prints the TurnResult as JSON.
const [ref, input] = process.argv.slice(2)
if (ref === undefined || input === undefined) {
  console.error("usage: bun scripts/opencode-resume-child.ts <ref> <prompt>")
  process.exit(2)
}

const harness = await open("opencode")
// No model needed when resuming: the session already carries its own.
const session = await harness.createSession({ cwd: process.cwd(), sessionRef: sessionRef(ref) })
const result = await session.prompt(input)
await session.dispose()
console.log(JSON.stringify(result))

import { open } from "../src/registry.ts"
import { sessionRef } from "../src/types.ts"
import "../src/adapters/claude-code/index.ts"

// Child process for the cross-process resume conformance case: resumes a ref
// in this fresh process, runs one prompt, prints the TurnResult as JSON.
const [ref, input] = process.argv.slice(2)
if (ref === undefined || input === undefined) {
  console.error("usage: bun scripts/claude-code-resume-child.ts <ref> <prompt>")
  process.exit(2)
}

const harness = await open("claude-code")
const session = await harness.createSession({ cwd: process.cwd(), sessionRef: sessionRef(ref) })
const result = await session.prompt(input)
await session.dispose()
console.log(JSON.stringify(result))

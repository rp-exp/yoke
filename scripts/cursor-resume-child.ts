import { open } from "../src/registry.ts"
import { sessionRef } from "../src/types.ts"
import "../src/adapters/cursor/index.ts"

// Child process for the cross-process resume conformance case: resumes a ref
// in this fresh process, runs one prompt, prints the TurnResult as JSON.
const [ref, input] = process.argv.slice(2)
if (ref === undefined || input === undefined) {
  console.error("usage: bun scripts/cursor-resume-child.ts <ref> <prompt>")
  process.exit(2)
}

const model = process.env.YOKE_MODEL
if (model === undefined) {
  // Local cursor agents require an explicit model; keep parent/child in sync.
  console.error("YOKE_MODEL must be set for the cursor resume child")
  process.exit(2)
}

const harness = await open("cursor")
const session = await harness.createSession({
  cwd: process.cwd(),
  sessionRef: sessionRef(ref),
  model,
})
const result = await session.prompt(input)
await session.dispose()
console.log(JSON.stringify(result))

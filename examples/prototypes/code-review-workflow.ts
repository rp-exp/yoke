/**
 * PROTOTYPE — throwaway. The code-review workflow: two independent read-only
 * reviewers (different harnesses, different models) fan out in parallel and
 * their findings merge. Written against the workflow stub (src/workflow.ts)
 * to test the shape; composes with implement-workflow.ts in
 * implement-and-review-workflow.ts.
 *
 * Run against scripted fake agents (no harness needed):
 *   bun examples/prototypes/code-review-workflow.ts --fake
 * Or against real harnesses:
 *   bun examples/prototypes/code-review-workflow.ts "the uncommitted changes"
 */

import { runWorkflow } from "../../src/workflow.ts"
import { collectReviews, registerFakes, renderReport } from "./shared.ts"

// --- The workflow

export async function codeReview(scope: string): Promise<ReturnType<typeof collectReviews>> {
  return collectReviews(scope)
}

// --- Entry point

async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  const fake = argv.includes("--fake")
  const scope = argv.filter((arg) => arg !== "--fake").join(" ") || "the uncommitted changes in the working tree"

  if (fake) registerFakes()

  const report = await runWorkflow(() => codeReview(scope))
  console.log(`\n${renderReport(report)}`)
  // A review that found things should say so to the shell.
  process.exit(report.length > 0 ? 1 : 0)
}

if (import.meta.main) {
  await main()
}

/**
 * PROTOTYPE — throwaway. The chained workflow: implement, then code review,
 * fixing blockers until the review comes back clean (or rounds run out).
 *
 * The point of this file is the composition itself: `implement` and
 * `codeReview` are imported unchanged from the two standalone prototypes —
 * chaining is a plain function call, not a framework feature.
 *
 * Run against scripted fake agents (no harness needed):
 *   bun examples/prototypes/implement-and-review-workflow.ts --fake "add fizzbuzz CLI"
 * Or against real harnesses:
 *   bun examples/prototypes/implement-and-review-workflow.ts "add fizzbuzz CLI"
 */

import { runWorkflow } from "../../src/workflow.ts"
import { coder, registerFakes, renderReport } from "./shared.ts"
import { implement } from "./implement-workflow.ts"
import { codeReview } from "./code-review-workflow.ts"

const MAX_FIX_ROUNDS = 3
const BLOCKER_SEVERITIES = new Set(["critical", "high"])

// --- The workflow

async function implementAndReview(task: string): Promise<{ summary: string; report: Awaited<ReturnType<typeof codeReview>> }> {
  const summary = await implement(task)

  let report = await codeReview(`the implementation of "${task}"`)
  for (let round = 1; report.some((f) => BLOCKER_SEVERITIES.has(f.severity)); round += 1) {
    if (round >= MAX_FIX_ROUNDS) {
      throw new Error(`still ${report.length} blocker(s) after ${MAX_FIX_ROUNDS - 1} fix rounds`)
    }
    console.log(`round ${round}: fixing ${report.length} blocker(s)`)
    // Mutating fix turn — fail-fast default, no blind retries.
    const lines = report.map((f) => `- ${f.id} [${f.severity}] ${f.path}:${f.line} — ${f.title}`).join("\n")
    await coder.run(`Fix these review findings:\n${lines}`)
    report = await codeReview(`the implementation of "${task}" after fixes`)
  }

  return { summary, report }
}

// --- Entry point

async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  const fake = argv.includes("--fake")
  const task = argv.filter((arg) => arg !== "--fake").join(" ")
  if (task === "") {
    throw new Error("usage: bun examples/prototypes/implement-and-review-workflow.ts [--fake] <task>")
  }

  if (fake) registerFakes()

  const { summary, report } = await runWorkflow(() => implementAndReview(task))
  console.log(`\n${summary}\n\nFinal review:\n${renderReport(report)}`)
  process.exit(report.some((f) => BLOCKER_SEVERITIES.has(f.severity)) ? 1 : 0)
}

if (import.meta.main) {
  await main()
}

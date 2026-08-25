/**
 * PROTOTYPE — throwaway. The ship workflow: the `implement` command, then
 * code review, fixing blockers and re-confirming CI until everything is
 * green. "Ship" because that is the user-facing verb — implement + review +
 * green CI is one thing from the outside.
 *
 * The point of this file is the composition itself: `implementTicket`,
 * `keepCiGreen`, and `codeReview` are imported unchanged from the two
 * standalone prototypes — composition is a plain function call, not a
 * framework feature.
 *
 * Run against scripted fakes (no harness, no gh):
 *   bun examples/prototypes/ship-workflow.ts --fake 42
 * Or for real:
 *   bun examples/prototypes/ship-workflow.ts 42
 */

import { runWorkflow } from "../../src/workflow.ts"
import { coder, fakeEnv, registerFakes, type Environment } from "./shared.ts"
import { implementTicket, keepCiGreen, realEnv } from "./implement-workflow.ts"
import { codeReview, renderReport } from "./code-review-workflow.ts"

const MAX_FIX_ROUNDS = 3
const BLOCKER_SEVERITIES = new Set(["critical", "high"])

// --- The workflow

async function ship(
  env: Environment,
  ticketRef: string,
): Promise<{ prUrl: string; report: Awaited<ReturnType<typeof codeReview>> }> {
  const { prUrl } = await implementTicket(env, ticketRef)

  let report = await codeReview(`PR ${prUrl}`)
  for (let round = 1; report.some((f) => BLOCKER_SEVERITIES.has(f.severity)); round += 1) {
    if (round >= MAX_FIX_ROUNDS) {
      throw new Error(`still ${report.length} blocker(s) after ${MAX_FIX_ROUNDS - 1} fix rounds`)
    }
    console.log(`review round ${round}: fixing ${report.length} blocker(s)`)
    // Mutating fix turn — fail-fast default, no blind retries.
    const lines = report.map((f) => `- ${f.id} [${f.severity}] ${f.path}:${f.line} — ${f.title}`).join("\n")
    await coder.run(`Fix these review findings:\n${lines}`)
    report = await codeReview(`PR ${prUrl} after fixes`)
  }

  // Fixes may have touched code — CI must be green again before reporting.
  await keepCiGreen(env, prUrl)

  return { prUrl, report }
}

// --- Entry point

async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  const fake = argv.includes("--fake")
  const ticketRef = argv.filter((arg) => arg !== "--fake").join(" ") || (fake ? "42" : "")
  if (ticketRef === "") {
    throw new Error("usage: bun examples/prototypes/ship-workflow.ts [--fake] <ticket>")
  }

  if (fake) registerFakes()

  const env = fake ? fakeEnv : realEnv
  const { prUrl, report } = await runWorkflow(() => ship(env, ticketRef))
  console.log(`\n${prUrl} — all required checks green\n\nFinal review:\n${renderReport(report)}`)
  process.exit(report.some((f) => BLOCKER_SEVERITIES.has(f.severity)) ? 1 : 0)
}

if (import.meta.main) {
  await main()
}

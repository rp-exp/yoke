/**
 * PROTOTYPE — throwaway. The ship workflow: implement, then review-and-fix
 * until no blockers, then re-confirm CI. "Ship" because that is the
 * user-facing verb — implement + review + green CI is one thing from the
 * outside.
 *
 * The point of this file is the composition itself: ship is three plain
 * function calls into the two standalone prototypes, sharing one build
 * conversation — composition is not a framework feature.
 *
 * Run against a scripted fake environment (no harness, no gh):
 *   bun examples/prototypes/ship-workflow.ts --fake 42
 * Or for real:
 *   bun examples/prototypes/ship-workflow.ts 42
 */

import { runWorkflow } from "../../src/workflow.ts"
import { makeFakeEnv, type Environment, type Report } from "./shared.ts"
import { implementTicket, keepCiGreen, realEnv } from "./implement-workflow.ts"
import { renderReport, reviewUntilNoBlockers } from "./code-review-workflow.ts"

// --- The workflow

async function ship(env: Environment, ticketRef: string): Promise<{ prUrl: string; report: Report }> {
  const { prUrl, build } = await implementTicket(env, ticketRef)

  // Review fixes continue the build conversation — the coder remembers what
  // it built and why.
  const report = await reviewUntilNoBlockers(env.reviewers, build, `PR ${prUrl}`)

  // Fixes may have touched code — green CI is ship's promise, so ship
  // re-confirms it, in the same build context.
  await keepCiGreen(env, prUrl, build)

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

  const env = fake ? makeFakeEnv() : realEnv
  const { prUrl, report } = await runWorkflow(() => ship(env, ticketRef))
  // The loop guarantees no blockers remain; the report may still carry
  // medium/low findings for the human to weigh.
  console.log(`\n${prUrl} — all required checks green\n\nFinal review:\n${renderReport(report)}`)
}

if (import.meta.main) {
  await main()
}

/**
 * PROTOTYPE — throwaway. The code-review workflow: two independent read-only
 * reviewers (different harnesses, different models) fan out in parallel and
 * their findings merge. Written against the workflow stub (src/workflow.ts)
 * to test the shape; composes with implement-workflow.ts in
 * ship-workflow.ts.
 *
 * The prompt delegates the review procedure to each agent's locally installed
 * `code-review` skill instead of restating it — the skill evolves outside
 * this file, and a copied procedure would drift. The prompt adds only the
 * orchestration contract: read-only, axis tagging, reply schema.
 *
 * Run against scripted fake agents (no harness needed):
 *   bun examples/prototypes/code-review-workflow.ts --fake
 * Or against real harnesses:
 *   bun examples/prototypes/code-review-workflow.ts "the uncommitted changes"
 */

import { runWorkflow } from "../../src/workflow.ts"
import {
  jsonShape,
  registerFakes,
  Review,
  reviewerClaude,
  reviewerCursor,
  type CodedFinding,
  type Report,
  type Severity,
} from "./shared.ts"

// --- Prompt: procedure lives in the skill; only the contract lives here.

const reviewPrompt = (scope: string): string =>
  `Review ${scope} by following the \`code-review\` skill (load it via the skill tool if you haven't).\n` +
  `- Read-only: never edit anything.\n` +
  `- Report every finding tagged with the code-review axis it belongs to: "standards" or "spec".\n` +
  jsonShape(Review)

// --- The workflow

const SEVERITY_ORDER: readonly Severity[] = ["critical", "high", "medium", "low"]

export function renderReport(report: Report): string {
  if (report.length === 0) return "No findings."
  const rank = (finding: CodedFinding): number => SEVERITY_ORDER.indexOf(finding.severity)
  return [...report]
    .sort((a, b) => rank(a) - rank(b))
    .map(
      (f) =>
        `- [${f.severity}] ${f.id} (${f.axis}) ${f.path}:${f.line} — ${f.title}\n  ${f.explanation}`,
    )
    .join("\n")
}

/**
 * Two reviewers in parallel — the barrier is fine, both are read-only turns,
 * which is also why they opt into `"transient"` retries. Findings merge with
 * ids attached; duplicates are left for the workflow's consumer to account
 * for (dedupe across reviewers is domain logic, not layer machinery).
 */
export async function codeReview(scope: string): Promise<Report> {
  const retryOpts = { retries: "transient" } as const
  const [first, second] = await Promise.all([
    reviewerClaude.ask(reviewPrompt(scope), Review, retryOpts),
    reviewerCursor.ask(reviewPrompt(scope), Review, retryOpts),
  ])
  console.log(`reviewers returned ${first.findings.length} + ${second.findings.length} finding(s)`)
  return [first, second].flatMap((review, i) =>
    review.findings.map((finding, j) => ({ ...finding, id: `r${i + 1}.${j + 1}` })),
  )
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

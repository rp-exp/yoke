/**
 * PROTOTYPE — throwaway. The code-review workflows: `codeReview` is one
 * read-only round — independent reviewers (different harnesses, different
 * models) fan out in parallel and their findings merge. On top of it,
 * `reviewUntilNoBlockers` owns the fix loop: review, have a fixer address
 * the findings, re-review with FRESH reviewers, until no blockers remain.
 * Mutation never leaks into `codeReview` itself — it belongs to the fixer
 * conversation the caller passes in. Composes with implement-workflow.ts in
 * ship-workflow.ts.
 *
 * The prompt delegates the review procedure to each agent's locally installed
 * `code-review` skill instead of restating it — the skill evolves outside
 * this file, and a copied procedure would drift. The prompt adds only the
 * orchestration contract (read-only, axis tagging); the reply schema is
 * stated by `ask` itself.
 *
 * Run against a scripted fake environment (no harness needed):
 *   bun examples/prototypes/code-review-workflow.ts --fake
 * Or against real harnesses:
 *   bun examples/prototypes/code-review-workflow.ts "the uncommitted changes"
 */

import { runWorkflow, type Agent, type Conversation } from "../../src/workflow.ts"
import {
  makeFakeEnv,
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
  `- Report every finding tagged with the code-review axis it belongs to: "standards" or "spec".`

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
 * Every call opens FRESH reviewer conversations: a full re-review with no
 * memory of prior rounds is the only proof a finding was resolved (the
 * review-rounds rule). Reviewers run in parallel — the barrier is fine, they
 * are read-only turns (which is also why their specs declare `"transient"`
 * retries). Findings merge with ids attached; duplicates are left for the
 * workflow's consumer to account for (dedupe across reviewers is domain
 * logic, not machinery).
 */
export async function codeReview(reviewers: readonly Agent[], scope: string): Promise<Report> {
  const reviews = await Promise.all(reviewers.map((r) => r.open().ask(reviewPrompt(scope), Review)))
  console.log(`reviewers returned ${reviews.map((r) => r.findings.length).join(" + ")} finding(s)`)
  return reviews.flatMap((review, i) =>
    review.findings.map((finding, j) => ({ ...finding, id: `r${i + 1}.${j + 1}` })),
  )
}

const MAX_FIX_ROUNDS = 3
const BLOCKER_SEVERITIES: ReadonlySet<Severity> = new Set(["critical", "high"])

const hasBlockers = (report: Report): boolean => report.some((f) => BLOCKER_SEVERITIES.has(f.severity))

/**
 * The review-fix loop. Blockers drive another round; every finding (any
 * severity) goes to the fixer while blockers remain, and the final report
 * may still carry medium/low findings — resolving those is the caller's
 * call. The fixer is a Conversation so fixes land with whatever context the
 * caller chooses — usually the conversation that built the change. CI after
 * fixes is deliberately NOT re-confirmed here: review knows nothing about
 * the world (gh); callers that promised green CI re-confirm it themselves.
 */
export async function reviewUntilNoBlockers(
  reviewers: readonly Agent[],
  fixer: Conversation,
  scope: string,
): Promise<Report> {
  let report = await codeReview(reviewers, scope)
  for (let round = 1; hasBlockers(report); round += 1) {
    if (round >= MAX_FIX_ROUNDS) {
      throw new Error(`still ${report.length} blocker(s) after ${MAX_FIX_ROUNDS - 1} fix rounds`)
    }
    console.log(`review round ${round}: fixing ${report.length} finding(s)`)
    // Mutating fix turn — fail-fast default, no blind retries.
    const lines = report.map((f) => `- ${f.id} [${f.severity}] ${f.path}:${f.line} — ${f.title}`).join("\n")
    await fixer.run(`Fix these review findings:\n${lines}`)
    report = await codeReview(reviewers, `${scope} after fixes`)
  }
  return report
}

// --- Entry point

async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  const fake = argv.includes("--fake")
  const scope = argv.filter((arg) => arg !== "--fake").join(" ") || "the uncommitted changes in the working tree"

  const reviewers = fake ? makeFakeEnv().reviewers : [reviewerClaude, reviewerCursor]
  const report = await runWorkflow(() => codeReview(reviewers, scope))
  console.log(`\n${renderReport(report)}`)
  // A review that found things should say so to the shell.
  process.exit(report.length > 0 ? 1 : 0)
}

if (import.meta.main) {
  await main()
}

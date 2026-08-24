/**
 * PROTOTYPE — throwaway. Vocabulary shared by the three workflow-shape
 * prototypes in this directory: agent definitions, schemas, prompts, report
 * rendering, and scripted fakes. Its real purpose is to answer whether the
 * workflows compose through plain imports — nothing here is an API commitment.
 */

import { z } from "zod"
import { agent, fakeAgent } from "../../src/workflow.ts"

// --- Agents: named once here, reused by every workflow that needs them.

export const coder = agent("coder", {
  harness: "opencode",
  model: "opencode-go/ox-alpha-free",
  effort: "high",
})

export const reviewer = agent("reviewer", { harness: "claude-code", model: "opus", effort: "high" })

export const auditor = agent("auditor", { harness: "cursor", model: "grok-4.6", effort: "high" })

// --- Schemas: declared once; TS types derive from them.

export const Severity = z.enum(["critical", "high", "medium", "low"])
export type Severity = z.infer<typeof Severity>

export const Finding = z.object({
  path: z.string().min(1),
  line: z.number().int().min(1),
  title: z.string().min(1),
  severity: Severity,
  explanation: z.string().min(1),
})
export type Finding = z.infer<typeof Finding>

export const Review = z.object({ findings: z.array(Finding) })
export type Review = z.infer<typeof Review>

/** Findings gain stable ids only when multiple reports merge. */
export interface CodedFinding extends Finding {
  readonly id: string
}

export type Report = readonly CodedFinding[]

// --- Prompts

/** The reply contract a structured turn must satisfy, generated from the schema. */
export const jsonShape = (schema: z.ZodType): string =>
  `Reply with ONLY a JSON object matching exactly:\n${JSON.stringify(z.toJSONSchema(schema))}`

export const reviewPrompt = (scope: string): string =>
  `Review ${scope}. Read-only: never edit anything.\n${jsonShape(Review)}`

// --- The review workflow's core: used standalone and by the chained prototype.

const SEVERITY_ORDER: readonly Severity[] = ["critical", "high", "medium", "low"]

export function renderReport(report: Report): string {
  if (report.length === 0) return "No findings."
  const rank = (finding: CodedFinding): number => SEVERITY_ORDER.indexOf(finding.severity)
  return [...report]
    .sort((a, b) => rank(a) - rank(b))
    .map(
      (f) => `- [${f.severity}] ${f.id} ${f.path}:${f.line} — ${f.title}\n  ${f.explanation}`,
    )
    .join("\n")
}

/**
 * Two independent read-only reviewers in parallel (different harnesses,
 * different models); findings merge with ids attached. Read-only turns opt
 * into `"transient"` retries — repeating them wholesale is safe.
 */
export async function collectReviews(scope: string): Promise<Report> {
  const retryOpts = { retries: "transient" } as const
  const [first, second] = await Promise.all([
    reviewer.ask(reviewPrompt(scope), Review, retryOpts),
    auditor.ask(reviewPrompt(scope), Review, retryOpts),
  ])
  console.log(`reviewers returned ${first.findings.length} + ${second.findings.length} finding(s)`)
  const report = [first, second].flatMap((review, i) =>
    review.findings.map((finding, j) => ({ ...finding, id: `r${i + 1}.${j + 1}` })),
  )
  return report
}

// --- Scripted fakes so any prototype runs end to end without harnesses.

/**
 * Narrative: before any fix turn, the auditor's very first reply is malformed
 * (demonstrating the schema-driven repair loop) and both reviewers report one
 * finding; after the coder addresses findings, both report clean.
 */
export function registerFakes(): void {
  let fixed = false
  const malformedTried = new Set<string>()

  fakeAgent("coder", (prompt) => {
    if (prompt.includes("Plan the implementation")) {
      return 'Here is my plan:\n{"steps":["write fizzbuzz module","wire up the CLI entry"]}'
    }
    if (prompt.includes("Fix these")) {
      fixed = true
      return "Addressed the findings."
    }
    return "Implemented the step."
  })

  const oneFinding = JSON.stringify({
    findings: [
      {
        path: "src/fizz.ts",
        line: 3,
        title: "n=0 case unhandled",
        severity: "high",
        explanation: "fizzbuzz(0) falls through to the default branch and prints nothing.",
      },
    ],
  })

  const replyFor = (id: string): string => {
    if (fixed) return '{"findings":[]}'
    // Each reviewer's first-ever reply is malformed — refused; the refusal
    // names the issues, and the corrected retry lands.
    if (!malformedTried.has(id)) {
      malformedTried.add(id)
      return '{"findings":[{"path":"src/fizz.ts","line":3,"severity":"high"}]}'
    }
    return oneFinding
  }

  fakeAgent("reviewer", () => replyFor("reviewer"))
  fakeAgent("auditor", () => replyFor("auditor"))
}

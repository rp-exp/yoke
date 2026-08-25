/**
 * PROTOTYPE — throwaway. Vocabulary shared by the three workflow-shape
 * prototypes in this directory: agent definitions, schemas, the environment
 * seam, and scripted fakes. Workflow logic lives in the workflow files, not
 * here. Nothing is an API commitment.
 */

import { z } from "zod"
import { agent, fakeAgent } from "../../src/workflow.ts"

// --- Agents: named once here, reused by every workflow that needs them.

export const coder = agent("building-opencode", {
  harness: "opencode",
  model: "opencode-go/ox-alpha-free",
  effort: "high",
})

export const reviewerClaude = agent("reviewing-claude-code", { harness: "claude-code", model: "opus", effort: "high" })

export const reviewerCursor = agent("reviewing-cursor", { harness: "cursor", model: "grok-4.6", effort: "high" })

// --- Schemas: declared once; TS types derive from them.

export const Severity = z.enum(["critical", "high", "medium", "low"])
export type Severity = z.infer<typeof Severity>

export const Finding = z.object({
  path: z.string().min(1),
  line: z.number().int().min(1),
  title: z.string().min(1),
  severity: Severity,
  /** Which code-review axis the finding belongs to ("standards"|"spec"). */
  axis: z.enum(["standards", "spec"]),
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

// --- Environment seam: the deterministic, world-touching steps (gh) sit
// --- behind an interface so workflows stay pure and fakes stay trivial.

export interface Ticket {
  readonly id: string
  readonly title: string
  readonly body: string
}

export interface Environment {
  /** Resolves a ticket reference; throws when it resolves to nothing. */
  resolveTicket(raw: string): Promise<Ticket>
  openPr(): Promise<string>
  /** Blocks until checks finish; returns the failing check names. */
  failingChecks(prUrl: string): Promise<readonly string[]>
}

// --- Scripted fakes so any prototype runs end to end without harnesses or gh.

let ciFixed = false
let reviewFixed = false
const malformedTried = new Set<string>()

/**
 * Narrative: the first CI watch fails one check (the coder fixes it and CI
 * goes green); each reviewer's first-ever reply is malformed (the schema
 * repair loop recovers) and reports one high finding until the coder
 * addresses review findings.
 */
export function registerFakes(): void {
  ciFixed = false
  reviewFixed = false
  malformedTried.clear()

  fakeAgent("building-opencode", (prompt) => {
    if (prompt.includes("Diagnose, fix, and push")) {
      ciFixed = true
      return "Fixed the failing checks and pushed."
    }
    if (prompt.includes("Fix these")) {
      reviewFixed = true
      return "Addressed the findings and pushed."
    }
    return "Implemented the ticket on a feature branch."
  })

  const oneFinding = JSON.stringify({
    findings: [
      {
        path: "src/fizz.ts",
        line: 3,
        title: "n=0 case unhandled",
        severity: "high",
        axis: "spec",
        explanation: "fizzbuzz(0) falls through to the default branch and prints nothing.",
      },
    ],
  })

  const replyFor = (id: string): string => {
    if (reviewFixed) return '{"findings":[]}'
    if (!malformedTried.has(id)) {
      malformedTried.add(id)
      return '{"findings":[{"path":"src/fizz.ts","line":3,"severity":"high"}]}'
    }
    return oneFinding
  }

  fakeAgent("reviewing-claude-code", () => replyFor("reviewing-claude-code"))
  fakeAgent("reviewing-cursor", () => replyFor("reviewing-cursor"))
}

export const fakeEnv: Environment = {
  resolveTicket: async (raw) =>
    /^\d+$/.test(raw.trim())
      ? {
          id: `#${raw.trim()}`,
          title: "Add fizzbuzz CLI",
          body: "Add a fizzbuzz CLI: `bun fizzbuzz <n>` prints the classic sequence. See parent spec SPEC-12.",
        }
      : { id: "inline", title: "Inline task", body: raw },
  openPr: async () => "https://github.com/rp-exp/yoke/pull/7",
  failingChecks: async () => (ciFixed ? [] : ["test"]),
}

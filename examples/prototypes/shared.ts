/**
 * PROTOTYPE — throwaway. Vocabulary shared by the three workflow-shape
 * prototypes in this directory: agent definitions, schemas, and the
 * environment seam. Workflow logic lives in the workflow files, not here.
 * Nothing is an API commitment.
 */

import { z } from "zod"
import { agent, fakeAgent, type Agent } from "../../src/workflow.ts"

// --- Agents: named once here, reused by every workflow that needs them.

export const coder = agent("building-opencode", {
  harness: "opencode",
  model: "opencode/claude-opus-5",
  effort: "high",
})

// Reviewers are read-only by role, so repeating a failed turn is safe —
// declared once in the spec instead of threaded through every call site.
export const reviewerClaude = agent("reviewing-claude-code", {
  harness: "claude-code",
  model: "opus",
  effort: "high",
  retries: "transient",
})

export const reviewerCursor = agent("reviewing-cursor", {
  harness: "cursor",
  model: "grok-4.6",
  effort: "high",
  retries: "transient",
})

// --- Schemas: declared once; TS types derive from them. `ask()` states the
// --- reply contract from the schema itself, so prompts never restate it.

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

// --- Environment seam: ONE injected object holding everything a workflow
// --- reaches outward for — the fuzzy actors (agents) and the deterministic
// --- world-touching steps (gh). `--fake` swaps this single object.

export interface Ticket {
  readonly id: string
  readonly title: string
  readonly body: string
}

export interface Environment {
  readonly coder: Agent
  readonly reviewers: readonly Agent[]
  /** Resolves a ticket reference; throws when it resolves to nothing. */
  resolveTicket(raw: string): Promise<Ticket>
  openPr(): Promise<string>
  /** Blocks until checks finish; returns the failing check names. */
  failingChecks(prUrl: string): Promise<readonly string[]>
}

// --- Scripted fakes so any prototype runs end to end without harnesses or gh.

/**
 * Narrative: the first CI watch fails one check (the coder fixes it and CI
 * goes green); each reviewer's first-ever reply is malformed (the `ask`
 * repair loop recovers) and reports one high finding until the coder
 * addresses review findings. All state lives in this closure — each call is
 * a fresh fake world, nothing module-level.
 */
export function makeFakeEnv(): Environment {
  let ciFixed = false
  let reviewFixed = false

  const fakeCoder = fakeAgent("building-opencode", (prompt) => {
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

  const fakeReviewer = (id: string): Agent => {
    let malformedTried = false
    return fakeAgent(id, () => {
      if (reviewFixed) return '{"findings":[]}'
      if (!malformedTried) {
        malformedTried = true
        return '{"findings":[{"path":"src/fizz.ts","line":3,"severity":"high"}]}'
      }
      return oneFinding
    })
  }

  return {
    coder: fakeCoder,
    reviewers: [fakeReviewer("reviewing-claude-code"), fakeReviewer("reviewing-cursor")],
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
}

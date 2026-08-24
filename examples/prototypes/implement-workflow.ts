/**
 * PROTOTYPE — throwaway. The `implement` workflow written the way this repo
 * wishes it read, against a stub layer (src/workflow.ts). It answers one
 * question: is THIS the shape that makes workflows easy to read and change?
 *
 * Run against scripted fake agents (no harness needed):
 *   bun examples/prototypes/implement-workflow.ts --fake "add fizzbuzz CLI"
 * Or against real harnesses:
 *   bun examples/prototypes/implement-workflow.ts "add fizzbuzz CLI"
 */

import { agent, fakeAgent, runWorkflow } from "../../src/workflow.ts"

// --- Types + boundary validators: model output is untrusted; validate hard.

interface Plan {
  readonly steps: readonly string[]
}

function parsePlan(value: unknown): Plan {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("expected a JSON object")
  }
  const steps = (value as Record<string, unknown>).steps
  if (
    !Array.isArray(steps) ||
    steps.length === 0 ||
    steps.some((step) => typeof step !== "string" || step.length === 0)
  ) {
    throw new Error('plan needs a non-empty "steps" array of strings')
  }
  return { steps: steps as readonly string[] }
}

interface Verdict {
  readonly pass: boolean
  readonly findings: readonly string[]
}

function parseVerdict(value: unknown): Verdict {
  const record = value as Record<string, unknown>
  const findings = record.findings
  if (
    typeof record.pass !== "boolean" ||
    !Array.isArray(findings) ||
    findings.some((f) => typeof f !== "string")
  ) {
    throw new Error('verdict needs "pass":boolean and "findings":string[]')
  }
  return { pass: record.pass, findings: findings as readonly string[] }
}

// --- Agents

const MAX_FIX_ROUNDS = 3

const coder = agent("coder", {
  harness: "opencode",
  model: "opencode-go/ox-alpha-free",
  effort: "high",
})

const reviewer = agent("reviewer", { harness: "claude-code", model: "opus", effort: "high" })

// --- Prompts

const planPrompt = (task: string): string =>
  `Plan the implementation of this task in 1-5 concrete steps:\nTASK: ${task}\n` +
  `Reply with ONLY a JSON object: {"steps":["..."]}`

const implementPrompt = (task: string, step: string): string =>
  `Implement this step of the task. Work in the current directory.\nTASK: ${task}\nSTEP: ${step}`

const reviewPrompt = (task: string): string =>
  `Review the working tree against this task. Read-only: never edit anything.\nTASK: ${task}\n` +
  `Reply with ONLY a JSON object: {"pass":true|false,"findings":["what is wrong or missing"]}`

// --- The workflow

async function implement(task: string): Promise<string> {
  // Reviewing is read-only, so repeating a turn wholesale is safe.
  const reviewOpts = { retries: "transient" } as const

  const plan = await coder.ask(planPrompt(task), parsePlan)
  console.log(`plan: ${plan.steps.join(" → ")}`)

  for (const [index, step] of plan.steps.entries()) {
    // Mutating turns keep the fail-fast default — no blind retries.
    await coder.run(implementPrompt(task, step))

    let verdict = await reviewer.ask(reviewPrompt(task), parseVerdict, reviewOpts)
    for (let round = 1; !verdict.pass && round < MAX_FIX_ROUNDS; round++) {
      console.log(`step ${index + 1} round ${round}: fixing ${verdict.findings.length} finding(s)`)
      await coder.run(`Fix these review findings:\n${verdict.findings.join("\n")}`)
      verdict = await reviewer.ask(reviewPrompt(task), parseVerdict, reviewOpts)
    }
    if (!verdict.pass) {
      throw new Error(`step ${index + 1} ("${step}") still failing after ${MAX_FIX_ROUNDS - 1} fix rounds`)
    }
    console.log(`step ${index + 1}/${plan.steps.length} ok: ${step}`)
  }

  return coder.run(`Summarize what was implemented for: ${task}`)
}

// --- Entry point

async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  const fake = argv.includes("--fake")
  const task = argv.filter((arg) => arg !== "--fake").join(" ")
  if (task === "") throw new Error("usage: bun examples/prototypes/implement-workflow.ts [--fake] <task>")

  if (fake) registerFakes()

  const summary = await runWorkflow(() => implement(task))
  console.log(`\n${summary}`)
}

// Scripted agents so the workflow runs end to end without any harness.

function registerFakes(): void {
  let reviews = 0
  fakeAgent("coder", (prompt, call) => {
    if (prompt.includes("Plan the implementation")) {
      return 'Here is my plan:\n{"steps":["write fizzbuzz module","wire up the CLI entry"]}'
    }
    return call === 1
      ? "Implemented the step."
      : `Fixed the findings.\n{"ignored":"not parsed on run() turns"}`
  })
  fakeAgent("reviewer", (_prompt) => {
    reviews += 1
    return reviews % 2 === 1
      ? '{"pass":false,"findings":["edge case n=0 unhandled"]}'
      : '{"pass":true,"findings":[]}'
  })
}

await main()

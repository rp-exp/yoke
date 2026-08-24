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

import { z } from "zod"

import { agent, fakeAgent, runWorkflow } from "../../src/workflow.ts"

// --- Schemas: declared once; TS types and the prompt's JSON contract both
// --- derive from them, so prompt and validation cannot drift.

const Plan = z.object({
  steps: z.array(z.string().min(1)).min(1, "need at least one step"),
})
type Plan = z.infer<typeof Plan>

const Verdict = z
  .object({
    pass: z.boolean(),
    findings: z.array(z.string()),
  })
  .refine((v) => v.pass || v.findings.length > 0, "a failing review needs findings")

/** The reply contract a turn must satisfy, generated from the schema itself. */
const jsonShape = (schema: z.ZodType): string =>
  `Reply with ONLY a JSON object matching exactly:\n${JSON.stringify(z.toJSONSchema(schema))}`

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
  `Plan the implementation of this task in 1-5 concrete steps:\nTASK: ${task}\n${jsonShape(Plan)}`

const implementPrompt = (task: string, step: string): string =>
  `Implement this step of the task. Work in the current directory.\nTASK: ${task}\nSTEP: ${step}`

const reviewPrompt = (task: string): string =>
  `Review the working tree against this task. Read-only: never edit anything.\nTASK: ${task}\n${jsonShape(Verdict)}`

// --- The workflow

async function implement(task: string): Promise<string> {
  // Reviewing is read-only, so repeating a turn wholesale is safe.
  const reviewOpts = { retries: "transient" } as const

  const plan = await coder.ask(planPrompt(task), Plan)
  console.log(`plan: ${plan.steps.join(" → ")}`)

  for (const [index, step] of plan.steps.entries()) {
    // Mutating turns keep the fail-fast default — no blind retries.
    await coder.run(implementPrompt(task, step))

    let verdict = await reviewer.ask(reviewPrompt(task), Verdict, reviewOpts)
    for (let round = 1; !verdict.pass && round < MAX_FIX_ROUNDS; round++) {
      console.log(`step ${index + 1} round ${round}: fixing ${verdict.findings.length} finding(s)`)
      await coder.run(`Fix these review findings:\n${verdict.findings.join("\n")}`)
      verdict = await reviewer.ask(reviewPrompt(task), Verdict, reviewOpts)
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
    switch (reviews % 3) {
      case 1:
        return '{"pass":false}' // missing "findings" — refused; the refusal names the issue
      case 2:
        return '{"pass":false,"findings":["edge case n=0 unhandled"]}'
      default:
        return '{"pass":true,"findings":[]}'
    }
  })
}

await main()

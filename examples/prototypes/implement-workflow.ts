/**
 * PROTOTYPE — throwaway. The implement workflow written the way this repo
 * wishes it read, against a stub layer (src/workflow.ts). It answers one
 * question: is THIS the shape that makes workflows easy to read and change?
 *
 * Deliberately does NOT verify its own output — review lives in
 * code-review-workflow.ts, and the two compose in
 * implement-and-review-workflow.ts.
 *
 * Run against scripted fake agents (no harness needed):
 *   bun examples/prototypes/implement-workflow.ts --fake "add fizzbuzz CLI"
 * Or against real harnesses:
 *   bun examples/prototypes/implement-workflow.ts "add fizzbuzz CLI"
 */

import { z } from "zod"

import { runWorkflow } from "../../src/workflow.ts"
import { coder, jsonShape, registerFakes } from "./shared.ts"

// --- Schema

const Plan = z.object({
  steps: z.array(z.string().min(1)).min(1, "need at least one step"),
})
type Plan = z.infer<typeof Plan>

// --- Prompts

const planPrompt = (task: string): string =>
  `Plan the implementation of this task in 1-5 concrete steps:\nTASK: ${task}\n${jsonShape(Plan)}`

const implementPrompt = (task: string, step: string): string =>
  `Implement this step of the task. Work in the current directory.\nTASK: ${task}\nSTEP: ${step}`

// --- The workflow. Mutating turns keep the fail-fast default: no blind retries.

export async function implement(task: string): Promise<string> {
  const plan = await coder.ask(planPrompt(task), Plan)
  console.log(`plan: ${plan.steps.join(" → ")}`)

  for (const [index, step] of plan.steps.entries()) {
    await coder.run(implementPrompt(task, step))
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

if (import.meta.main) {
  await main()
}

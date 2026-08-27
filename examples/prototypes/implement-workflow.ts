/**
 * PROTOTYPE — throwaway. Port of the opencode `implement` command
 * (commands/implement.md) to the workflow stub: implement a ticket, open a PR
 * when ready, keep CI green, report the PR URL and final CI result.
 *
 * Division of labor is the point. The command delegated everything to the
 * agent; here the script owns every deterministic step — ticket lookup
 * (fails fast when it resolves to nothing), PR creation, CI watching — and
 * the agent keeps only the fuzzy step: implementing via its `implement`
 * skill. Same five steps, same outcome, deterministic where possible.
 *
 * Run against a scripted fake environment (no harness, no gh):
 *   bun examples/prototypes/implement-workflow.ts --fake 42
 * Or for real:
 *   bun examples/prototypes/implement-workflow.ts 42
 *   bun examples/prototypes/implement-workflow.ts "freeform task text"
 */

import { runWorkflow, type Conversation } from "../../src/workflow.ts"
import { coder, makeFakeEnv, reviewerClaude, reviewerCursor, type Environment } from "./shared.ts"

// --- The real environment: real agents; gh is the boundary; failures are loud.

export const realEnv: Environment = {
  coder,
  reviewers: [reviewerClaude, reviewerCursor],

  async resolveTicket(raw: string) {
    const value = raw.trim()
    const numbered =
      value.match(/^(?:[\w.-]+\/[\w.-]+)?#?(\d+)$/) ?? value.match(/github\.com\/[\w.-]+\/[\w.-]+\/issues\/(\d+)/)
    if (numbered === null) return { id: "inline", title: "Inline task", body: value }
    const number = numbered[1]
    if (number === undefined) throw new Error(`cannot parse ticket reference: ${JSON.stringify(raw)}`)
    const view = sh(["gh", "issue", "view", number, "--json", "number,title,body"])
    const info = JSON.parse(view) as { number: number; title: string; body: string }
    return { id: `#${info.number}`, title: info.title, body: info.body }
  },

  async openPr() {
    const view = sh(["gh", "pr", "create", "--fill", "--json", "url"])
    return (JSON.parse(view) as { url: string }).url
  },

  async failingChecks(prUrl: string) {
    const proc = Bun.spawnSync(["gh", "pr", "checks", prUrl, "--watch"], { stdout: "pipe", stderr: "pipe" })
    if (proc.exitCode === 0) return []
    return proc.stdout
      .toString()
      .split("\n")
      .filter((line) => line.includes("fail"))
      .map((line) => line.split("\t")[0]?.trim() ?? line.trim())
  },
}

function sh(cmd: readonly string[]): string {
  const proc = Bun.spawnSync([...cmd], { stdout: "pipe", stderr: "pipe" })
  if (proc.exitCode !== 0) {
    throw new Error(`${cmd.join(" ")} failed (${proc.exitCode}): ${proc.stderr.toString().trim()}`)
  }
  return proc.stdout.toString().trim()
}

// --- Prompts

const implementPrompt = (ticket: { id: string; title: string; body: string }): string =>
  `Implement this ticket by following your \`implement\` skill (load it via the skill tool if you haven't).\n` +
  `Ticket ${ticket.id}: ${ticket.title}\n\n${ticket.body}\n\n` +
  `Commit the work on a feature branch. Do not open a PR or watch CI — the orchestrator owns both.`

const ciFixPrompt = (prUrl: string, failed: readonly string[]): string =>
  `Required CI checks are failing on ${prUrl}:\n${failed.map((name) => `- ${name}`).join("\n")}\n` +
  `Diagnose, fix, and push.`

// --- The workflow: the command's five steps, one named step each.

const MAX_CI_ROUNDS = 5

export async function implementTicket(
  env: Environment,
  ticketRef: string,
): Promise<{ ticket: { id: string; title: string }; prUrl: string; build: Conversation }> {
  // 1. Read the ticket. No ticket → stop and report.
  const ticket = await env.resolveTicket(ticketRef)
  console.log(`ticket ${ticket.id}: ${ticket.title}`)

  // One conversation for the whole build: implementation and every CI fix
  // share context — the coder remembers what it built. Returning `build`
  // lets callers (ship) continue THAT context with review fixes.
  const build = env.coder.open()

  // 2. Implement, delegating the procedure to the agent's `implement` skill.
  await build.run(implementPrompt(ticket))

  // 3. Open a PR when the implementation is ready.
  const prUrl = await env.openPr()
  console.log(`opened ${prUrl}`)

  // 4. Keep CI green: diagnose, fix, push again while anything fails.
  await keepCiGreen(env, prUrl, build)

  // 5. Report the PR URL and final CI result.
  return { ticket, prUrl, build }
}

/** Reusable: ship runs it again after review fixes, in the build context. */
export async function keepCiGreen(env: Environment, prUrl: string, build: Conversation): Promise<void> {
  for (let round = 1; ; round += 1) {
    const failed = await env.failingChecks(prUrl)
    if (failed.length === 0) return
    if (round >= MAX_CI_ROUNDS) {
      throw new Error(`CI still failing after ${MAX_CI_ROUNDS - 1} fix rounds: ${failed.join(", ")}`)
    }
    console.log(`CI failing (${failed.join(", ")}); fix round ${round}/${MAX_CI_ROUNDS - 1}`)
    // Mutating turn — fail-fast default, no blind retries.
    await build.run(ciFixPrompt(prUrl, failed))
  }
}

// --- Entry point

async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  const fake = argv.includes("--fake")
  const ticketRef = argv.filter((arg) => arg !== "--fake").join(" ") || (fake ? "42" : "")
  if (ticketRef === "") {
    throw new Error("usage: bun examples/prototypes/implement-workflow.ts [--fake] <ticket-number-or-task>")
  }

  const { prUrl } = await runWorkflow(() => implementTicket(fake ? makeFakeEnv() : realEnv, ticketRef))
  console.log(`\n${prUrl} — all required checks green`)
}

if (import.meta.main) {
  await main()
}

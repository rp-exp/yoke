import { runConformance } from "../src/conformance/index.ts"
import type { TierASubject } from "../src/conformance/index.ts"
import type { Harness } from "../src/types.ts"
import { open } from "../src/registry.ts"
import "../src/adapters/cursor/index.ts"

/**
 * Opt-in live conformance against your Cursor account.
 * Requires CURSOR_API_KEY (user key from Dashboard → API Keys; usage bills to
 * your plan's pools like IDE usage) or a stored Cursor.auth.login() key.
 * Run: YOKE_MODEL=composer-2.5 bun run conformance:cursor
 */

const MODEL = process.env.YOKE_MODEL ?? "composer-2.5"

// Tool-free long generation keeps the turn in flight for the competing-call
// window without depending on local tool auto-approval behavior.
const slowPrompt =
  "Without using any tools, write a roughly 2500-word essay on the history of velcro, then reply with exactly: done"

const subject: TierASubject = {
  harnessId: "cursor",
  tier: "A",
  slowPrompt,
  open: async (): Promise<Harness> => {
    const base = await open("cursor")
    return {
      id: base.id,
      createSession: (opts) => base.createSession({ ...opts, model: MODEL }),
    }
  },
  resumeInChildProcess: async (ref, input) => {
    const proc = Bun.spawnSync(["bun", "scripts/cursor-resume-child.ts", ref, input], {
      env: { ...process.env, YOKE_MODEL: MODEL },
    })
    const stdout = proc.stdout.toString().trim()
    if (proc.exitCode !== 0 || stdout === "") {
      throw new Error(`resume child failed (${proc.exitCode}): ${proc.stderr.toString()}`)
    }
    return JSON.parse(stdout)
  },
}

const report = await runConformance(subject)
for (const result of report.results) {
  const mark = result.status === "pass" ? "PASS" : result.status === "fail" ? "FAIL" : "SKIP"
  console.log(`${mark}  ${result.name}${result.error !== undefined ? `\n      ${result.error}` : ""}`)
}
if (!report.passed) process.exit(1)

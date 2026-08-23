import { runConformance } from "../src/conformance/index.ts"
import type { TierASubject } from "../src/conformance/index.ts"
import type { Harness } from "../src/types.ts"
import { open } from "../src/registry.ts"
import "../src/adapters/claude-code/index.ts"

/**
 * Opt-in live conformance against your local Claude Code install.
 * Requires the `claude` CLI installed and logged in. Run: bun run conformance:claude-code
 */

const MODEL = process.env.YOKE_MODEL

// No shell tool needed: headless sessions auto-deny permission prompts, so a
// long *generation* keeps the turn in flight instead of a denied `sleep`.
const slowPrompt =
  "Without using any tools, write a roughly 2500-word essay on the history of paperclips, then reply with exactly: done"

const subject: TierASubject = {
  harnessId: "claude-code",
  tier: "A",
  slowPrompt,
  open: async (): Promise<Harness> => {
    const base = await open("claude-code")
    if (MODEL === undefined) return base
    return {
      id: base.id,
      createSession: (opts) => base.createSession({ ...opts, model: MODEL }),
    }
  },
  resumeInChildProcess: async (ref, input) => {
    const proc = Bun.spawnSync(["bun", "scripts/claude-code-resume-child.ts", ref, input])
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

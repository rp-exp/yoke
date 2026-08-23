import { runConformance } from "../src/conformance/index.ts"
import type { TierASubject } from "../src/conformance/index.ts"
import { open } from "../src/registry.ts"
import "../src/adapters/opencode/index.ts"

/**
 * Opt-in live conformance against your local OpenCode V2 service.
 * Requires `opencode2` installed and logged in. Run: bun run conformance:opencode
 */

const subject: TierASubject = {
  harnessId: "opencode",
  tier: "A",
  // Stays in flight long enough for busy/abort windows. Adjust if your
  // permission config denies shell commands to the default agent.
  slowPrompt: "Use the shell tool to run exactly `sleep 8`, then reply with exactly: ok",
  open: () => open("opencode"),
  resumeInChildProcess: async (ref, input) => {
    const proc = Bun.spawnSync(["bun", "scripts/opencode-resume-child.ts", ref, input])
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

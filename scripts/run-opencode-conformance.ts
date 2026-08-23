import { runConformance } from "../src/conformance/index.ts"
import type { TierASubject } from "../src/conformance/index.ts"
import { open } from "../src/registry.ts"
import "../src/adapters/opencode/index.ts"

/**
 * Opt-in live conformance against your local OpenCode V2 service.
 * Requires `opencode2` installed and logged in. Run: bun run conformance:opencode
 */

// Cheap and fast beats smart here: conformance needs one-word replies and
// one-word recall, ~15 calls per run. Override with YOKE_MODEL when debugging.
// Note: google/* models fail on this setup (antigravity auth rejects plain API
// calls), so the default is a model verified to work headless.
const MODEL = process.env.YOKE_MODEL ?? "openai/gpt-5.6-luna"

const subject: TierASubject = {
  harnessId: "opencode",
  tier: "A",
  // Stays in flight long enough for busy/abort windows. Adjust if your
  // permission config denies shell commands to the default agent.
  slowPrompt: "Use the shell tool to run exactly `sleep 8`, then reply with exactly: ok",
  open: async () => {
    const base = await open("opencode")
    // Model is explicit so runs never depend on the service's default model.
    return {
      id: base.id,
      createSession: (opts) => base.createSession({ ...opts, model: MODEL }),
    }
  },
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

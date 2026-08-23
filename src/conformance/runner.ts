import type { Harness } from "../types.ts"
import type { CaseContext } from "./cases.ts"
import { CONFORMANCE_CASES } from "./cases.ts"
import type { CaseResult, ConformanceReport } from "./report.ts"
import type { ConformanceSubject } from "./subject.ts"

/**
 * Runs every conformance case against a subject and reports per-case outcomes.
 * Cases run sequentially; a failure doesn't mask later cases. The pre-flight
 * open() fails the whole run loudly when the harness is unreachable — no
 * silent skips (CONFORMANCE.md).
 */
export async function runConformance(subject: ConformanceSubject): Promise<ConformanceReport> {
  // Pre-flight: fail loudly here rather than surfacing as twelve confusing case failures.
  const opened = await subject.open()

  // Each case shares the pre-flighted harness; opening is cheap for real
  // adapters (connection reuse) and free for fakes.
  let harnessPromise: Promise<Harness> | null = null
  const ctx: CaseContext = {
    subject,
    harness() {
      harnessPromise ??= Promise.resolve(opened)
      return harnessPromise
    },
  }

  const results: CaseResult[] = []
  for (const testCase of CONFORMANCE_CASES) {
    if (testCase.tier === "A" && subject.tier !== "A") {
      results.push({ name: testCase.name, status: "skipped-tier" })
      continue
    }
    try {
      await testCase.run(ctx)
      results.push({ name: testCase.name, status: "pass" })
    } catch (err) {
      results.push({
        name: testCase.name,
        status: "fail",
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  const passed = results.every((r) => r.status !== "fail")
  return { harnessId: subject.harnessId, tier: subject.tier, results, passed }
}

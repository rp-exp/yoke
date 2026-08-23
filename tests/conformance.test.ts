import { describe, expect, test } from "bun:test"
import { runConformance } from "../src/conformance/index.ts"
import { makeFakeSubject } from "./fake-subject.ts"

describe("conformance runner", () => {
  test("reference implementation passes every tier-A case", async () => {
    const report = await runConformance(makeFakeSubject({ tier: "A" }))
    expect(report.harnessId).toBe("opencode")
    expect(report.results).toHaveLength(12)
    expect(report.results.filter((r) => r.status === "fail")).toEqual([])
    expect(report.passed).toBe(true)
  })

  test("tier-B subject skips tier-A cases explicitly, and still passes", async () => {
    const report = await runConformance(makeFakeSubject({ tier: "B" }))
    expect(report.tier).toBe("B")
    expect(report.results.filter((r) => r.status === "skipped-tier")).toHaveLength(4)
    expect(report.results.filter((r) => r.status === "fail")).toEqual([])
    expect(report.passed).toBe(true)
  })

  test("the suite catches contract violations, not just happy paths", async () => {
    const report = await runConformance(
      // A "broken adapter": no busy/ownership guards.
      makeFakeSubject({ tier: "A", enforceGuards: false }),
    )
    expect(report.passed).toBe(false)
    const failedNames = report.results.filter((r) => r.status === "fail").map((r) => r.name)
    expect(failedNames).toContain("second concurrent prompt rejects with HandleBusyError")
  })

  test("unreachable harness fails the whole run loudly", async () => {
    const subject = {
      ...makeFakeSubject({ tier: "A" as const }),
      open: () => Promise.reject(new Error("harness not authenticated")),
    }
    expect(runConformance(subject)).rejects.toThrow("harness not authenticated")
  })
})

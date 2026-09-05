import { describe, expect, test } from "bun:test"
import { YokeError } from "../src/errors.ts"
import { fakeAgent, type Agent } from "../src/workflow.ts"
import {
  assignAxes,
  Claims,
  Findings,
  parsePrRef,
  renderReport,
  runReviewRounds,
} from "../examples/review-rounds.ts"
import { silent, transientFailure } from "./fake-subject.ts"

const BASE = "aaa111"
const HEAD = "bbb222"

const CLAIMS = (ids: string[]) =>
  JSON.stringify({
    claims: ids.map((id) => ({
      id,
      title: `t-${id}`,
      locations: [{ path: "src/x.ts", line: 1 }],
      explanation: "e",
      suggestedSeverity: "high",
      axis: "standards",
    })),
  })

const FINDINGS = (entries: Array<{ id: string; sources: string[]; disposition: string }>) =>
  JSON.stringify({
    findings: entries.map(({ id, sources, disposition }) => ({
      id,
      title: `t-${id}`,
      locations: [{ path: "src/x.ts", line: 1 }],
      explanation: "e",
      sourceClaimReferences: sources,
      verification: "verified",
      decisionReason: "d",
      kind: disposition === "fix-now" ? "merge-blocker" : "improvement",
      severity: "high",
      disposition,
    })),
  })

/**
 * One prompt per round per reviewer, so a fake's call number is its round
 * number; scripts shorter than the round count repeat their last entry.
 */
const fakeReviewers = (perRound: string[][]): Agent[] =>
  ["opencode", "claude-code", "cursor"].map((id, reviewerIndex) =>
    fakeAgent(
      id,
      (_prompt, call) => perRound[Math.min(call - 1, perRound.length - 1)]?.[reviewerIndex] ?? CLAIMS([]),
    ),
  )

const fakeVerifier = (perRound: string[]): Agent =>
  fakeAgent("verifier", (_prompt, call) => perRound[Math.min(call - 1, perRound.length - 1)] ?? FINDINGS([]))

describe("reply schemas", () => {
  test("valid claims parse", () => {
    expect(Claims.parse(JSON.parse(CLAIMS(["a"]))).claims).toHaveLength(1)
  })

  test("claims must carry a known axis", () => {
    const badAxis = JSON.parse(CLAIMS(["a"]).replace('"axis":"standards"', '"axis":"vibes"'))
    expect(() => Claims.parse(badAxis)).toThrow(/axis/)
    const noAxis = JSON.parse(CLAIMS(["a"]).replace(',"axis":"standards"', ""))
    expect(() => Claims.parse(noAxis)).toThrow(/axis/)
  })

  test("findings without required fields fail loudly", () => {
    expect(() => Findings.parse({ findings: [{ id: "f", sourceClaimReferences: [] }] })).toThrow()
  })
})

describe("axis derivation and report", () => {
  test("findings inherit axis from their sourcing claims, not from the verifier", () => {
    const reports = [
      {
        reportID: "r1",
        claims: [
          { ...claimOf("hard1"), axis: "standards" as const, hardViolation: true as const },
          { ...claimOf("spec1"), axis: "spec" as const },
        ],
      },
    ]
    const findings = Findings.parse({
      findings: [
        { ...findingOf("F1", ["r1:hard1"]), verification: "verified" },
        { ...findingOf("F2", ["r1:spec1"]), verification: "verified" },
        { ...findingOf("F3", []), verification: "verified" },
      ],
    }).findings
    const [f1, f2, f3] = assignAxes(reports, findings)
    expect(f1?.axis).toBe("standards")
    expect(f1?.hardViolation).toBe(true)
    expect(f2?.axis).toBe("spec")
    expect(f2?.hardViolation).toBeUndefined()
    // Own verifier-added finding has no sources to inherit from.
    expect(f3?.axis).toBeUndefined()
  })

  test("report presents the two axes separately with per-axis worst issue", () => {
    const reports = [
      {
        reportID: "r1",
        claims: [
          { ...claimOf("h"), axis: "standards" as const, hardViolation: true as const },
          { ...claimOf("s"), axis: "spec" as const },
        ],
      },
    ]
    const raw = Findings.parse({
      findings: [
        { ...findingOf("SPEC-LOW", ["r1:s"]), severity: "low", disposition: "follow-up", verification: "verified" },
        { ...findingOf("STD-HIGH", ["r1:h"]), severity: "high", disposition: "fix-now", verification: "verified" },
        { ...findingOf("REJECTED", ["r1:h"]), verification: "false-positive", rejectionReason: "not in diff" },
      ],
    }).findings
    const report = renderReport({
      status: "round-limit",
      rounds: [],
      findings: assignAxes(reports, raw),
      outstandingFixNow: [],
    })
    expect(report).toMatch(/## Standards\n/)
    expect(report).toMatch(/## Spec\n/)
    expect(report).toContain("[hard violation]")
    expect(report).toContain("Worst:** STD-HIGH")
    // Rejected findings never surface.
    expect(report).not.toContain("REJECTED")
  })
})

function claimOf(id: string) {
  return {
    id,
    title: `t-${id}`,
    locations: [{ path: "src/x.ts", line: 1 }],
    explanation: "e",
    suggestedSeverity: "high" as const,
  }
}

function findingOf(id: string, refs: string[]) {
  return {
    id,
    title: `t-${id}`,
    locations: [{ path: "src/x.ts", line: 1 }],
    explanation: "e",
    sourceClaimReferences: refs,
  }
}

describe("pr ref parsing", () => {
  test("accepts every documented form", () => {
    expect(parsePrRef("42")).toEqual({ number: "42" })
    expect(parsePrRef(" #42 ")).toEqual({ number: "42" })
    expect(parsePrRef("rp-exp/yoke#42")).toEqual({ repo: "rp-exp/yoke", number: "42" })
    expect(parsePrRef("https://github.com/rp-exp/yoke/pull/7")).toEqual({ repo: "rp-exp/yoke", number: "7" })
  })

  test("rejects garbage loudly", () => {
    expect(() => parsePrRef("main")).toThrow(/cannot parse PR reference/)
    expect(() => parsePrRef("https://github.com/rp-exp/yoke/tree/main")).toThrow(/cannot parse PR reference/)
  })
})

describe("review-rounds orchestration", () => {
  test("clean first round stops immediately", async () => {
    const result = await runReviewRounds({
      reviewers: fakeReviewers([[CLAIMS([]), CLAIMS([]), CLAIMS([])]]),
      verifier: fakeVerifier([FINDINGS([])]),
      base: BASE,
      head: HEAD,
      maxRounds: 3,
      timeoutMs: 5_000,
      onRetry: silent,
    })
    expect(result.status).toBe("clean")
    expect(result.rounds).toHaveLength(1)
    expect(result.findings).toHaveLength(0)
  })

  test("fix-now findings drive more rounds; resolution reaches clean", async () => {
    const result = await runReviewRounds({
      reviewers: fakeReviewers([
        [CLAIMS(["r1"]), CLAIMS([]), CLAIMS([])],
        [CLAIMS([]), CLAIMS([]), CLAIMS([])],
      ]),
      // Round 1: one fix-now finding sourced from opencode's claim.
      // Round 2: resolved.
      verifier: fakeVerifier([
        FINDINGS([{ id: "F1", sources: ["opencode:r1"], disposition: "fix-now" }]),
        FINDINGS([]),
      ]),
      base: BASE,
      head: HEAD,
      maxRounds: 3,
      timeoutMs: 5_000,
      onRetry: silent,
    })
    expect(result.status).toBe("clean")
    expect(result.rounds).toHaveLength(2)
    // Fresh conversations each round: round 2 saw the fixed state.
    expect(result.rounds[1]?.claims).toBe(0)
  })

  test("round limit reports outstanding findings instead of looping forever", async () => {
    const roundsSeen: number[] = []
    const result = await runReviewRounds({
      reviewers: fakeReviewers([[CLAIMS(["x"]), CLAIMS([]), CLAIMS([])]]),
      verifier: fakeVerifier([FINDINGS([{ id: "F1", sources: ["opencode:x"], disposition: "fix-now" }])]),
      base: BASE,
      head: HEAD,
      maxRounds: 2,
      timeoutMs: 5_000,
      onRetry: silent,
      onRound: (summary) => roundsSeen.push(summary.round),
    })
    expect(result.status).toBe("round-limit")
    expect(result.outstandingFixNow).toEqual(["F1"])
    expect(roundsSeen).toEqual([1, 2])
  })

  test("malformed reviewer output is repaired against the same session", async () => {
    let calls = 0
    const flaky = fakeAgent("flaky", (_prompt, call) => {
      calls = call
      return call === 1 ? "not json at all" : CLAIMS(["ok"])
    })
    const result = await runReviewRounds({
      reviewers: [flaky, ...fakeReviewers([[CLAIMS([]), CLAIMS([]), CLAIMS([])]])],
      // The verifier must account for flaky's repaired claim.
      verifier: fakeVerifier([FINDINGS([{ id: "F1", sources: ["flaky:ok"], disposition: "skip" }])]),
      base: BASE,
      head: HEAD,
      maxRounds: 1,
      timeoutMs: 5_000,
      onRetry: silent,
    })
    expect(calls).toBe(2)
    expect(result.status).toBe("clean")
  })

  test("verifier accounting failure fails loud, never silently drops claims", async () => {
    const result = await runReviewRounds({
      reviewers: fakeReviewers([[CLAIMS(["c1"]), CLAIMS([]), CLAIMS([])]]),
      // Verifier invents a claim ref and drops the real one.
      verifier: fakeVerifier([FINDINGS([{ id: "F1", sources: ["opencode:nope"], disposition: "skip" }])]),
      base: BASE,
      head: HEAD,
      maxRounds: 3,
      timeoutMs: 5_000,
      onRetry: silent,
    })
    expect(result.status).toBe("accounting-failed")
  })

  test("permanent harness failure fails fast — no JSON-correction retry", async () => {
    let prompts = 0
    const broken = fakeAgent("broken", () => {
      prompts += 1
      throw new YokeError("opencode", "turn failed", { raw: { finish: "error" } })
    })
    const run = runReviewRounds({
      reviewers: [broken, ...fakeReviewers([[CLAIMS([]), CLAIMS([]), CLAIMS([])]])],
      verifier: fakeVerifier([FINDINGS([])]),
      base: BASE,
      head: HEAD,
      maxRounds: 1,
      timeoutMs: 5_000,
      onRetry: silent,
      backoffMs: () => 0,
    })
    // The YokeError propagates as-is, not wrapped in "failed to submit valid JSON".
    await expect(run).rejects.toThrow(YokeError)
    await run.catch((err: Error) => expect(err.message).toMatch(/turn failed/))
    expect(prompts).toBe(1)
  })

  test("transient reviewer failure retries on fresh sessions and the round completes", async () => {
    let calls = 0
    const flaky = fakeAgent("flaky-provider", (_prompt, call) => {
      calls = call
      if (call <= 2) throw transientFailure()
      return CLAIMS(["ok"])
    })
    const result = await runReviewRounds({
      reviewers: [flaky, ...fakeReviewers([[CLAIMS([]), CLAIMS([]), CLAIMS([])]])],
      verifier: fakeVerifier([FINDINGS([{ id: "F1", sources: ["flaky-provider:ok"], disposition: "skip" }])]),
      base: BASE,
      head: HEAD,
      maxRounds: 1,
      timeoutMs: 5_000,
      onRetry: silent,
      backoffMs: () => 0,
    })
    expect(result.status).toBe("clean")
    expect(calls).toBe(3) // two transient failures, third session delivers
  })

  test("per-turn sessions are disposed, not retained until workflow end", async () => {
    let disposes = 0
    const onDispose = (): void => {
      disposes += 1
    }
    const reviewers: Agent[] = ["r1", "r2", "r3"].map((id) =>
      fakeAgent(id, () => CLAIMS([]), { onDispose }),
    )
    const verifier = fakeAgent("verifier", () => FINDINGS([]), { onDispose })
    const result = await runReviewRounds({
      reviewers,
      verifier,
      base: BASE,
      head: HEAD,
      maxRounds: 1,
      timeoutMs: 5_000,
      onRetry: silent,
    })
    expect(result.status).toBe("clean")
    // 3 reviewers + 1 verifier, 1 round — one dispose per turn.
    expect(disposes).toBe(4)
  })
})

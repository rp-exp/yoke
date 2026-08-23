import { describe, expect, test } from "bun:test"
import { YokeError } from "../src/errors.ts"
import type { AgentFactory, RoundAgent } from "../examples/tri-review-rounds.ts"
import {
  assignAxes,
  isTransientTurnFailure,
  parseJsonReply,
  parsePrRef,
  renderReport,
  retryBackoffMs,
  runTriReview,
  validateClaims,
  validateFindings,
} from "../examples/tri-review-rounds.ts"

const transientFailure = () =>
  new YokeError("opencode", "turn failed", {
    raw: { error: { type: "provider.invalid-output", message: "The provider response ended with an unknown finish reason." } },
  })

const BASE = "aaa111"
const HEAD = "bbb222"

function scriptedAgent(responses: string[], opts: { hang?: boolean } = {}): RoundAgent & { sent: string[] } {
  const sent: string[] = []
  let i = 0
  return {
    sent,
    prompt(input: string) {
      sent.push(input)
      if (opts.hang === true) return new Promise<string>(() => {})
      const reply = responses[Math.min(i, responses.length - 1)] ?? ""
      i += 1
      return Promise.resolve(reply)
    },
    abort: async () => {},
    dispose: async () => {},
  }
}

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

function fakeReviewers(perRoundResponses: string[][]): AgentFactory[] {
  let round = 0
  return ["opencode", "claude-code", "cursor"].map((id, reviewerIndex) => ({
    id,
    fresh: async () => {
      const responses = perRoundResponses[Math.min(round, perRoundResponses.length - 1)] ?? []
      round += 1
      return scriptedAgent([responses[reviewerIndex] ?? CLAIMS([])])
    },
  }))
}

function fakeVerifier(perRoundResponses: string[]): AgentFactory {
  let round = 0
  return {
    id: "verifier",
    fresh: async () => {
      const reply = perRoundResponses[Math.min(round, perRoundResponses.length - 1)] ?? FINDINGS([])
      round += 1
      return scriptedAgent([reply])
    },
  }
}

describe("boundary parsing", () => {
  test("parses bare and fenced JSON replies", () => {
    expect(parseJsonReply(CLAIMS(["a"]))).toEqual(JSON.parse(CLAIMS(["a"])))
    expect(parseJsonReply("```json\n" + CLAIMS(["a"]) + "\n```")).toEqual(JSON.parse(CLAIMS(["a"])))
    expect(parseJsonReply('Sure!\n{"claims":[]}')).toEqual({ claims: [] })
  })

  test("rejects non-JSON and schema violations loudly", () => {
    expect(() => parseJsonReply("no json here")).toThrow(/no JSON/)
    expect(() => validateClaims([{ id: "a" }])).toThrow()
    expect(() => validateFindings({ findings: [{ id: "f", sourceClaimReferences: [] }] })).toThrow()
  })

  test("claims must carry a known axis", () => {
    const badAxis = JSON.parse(CLAIMS(["a"]).replace('"axis":"standards"', '"axis":"vibes"'))
    expect(() => validateClaims(badAxis)).toThrow(/axis/)
    const noAxis = JSON.parse(CLAIMS(["a"]).replace(',"axis":"standards"', ""))
    expect(() => validateClaims(noAxis)).toThrow(/axis/)
  })
})

describe("axis derivation and report", () => {
  test("findings inherit axis from their sourcing claims, not from the verifier", () => {
    const reports = [
      {
        reportID: "r1",
        claims: [
          { ...claimOf("hard1"), axis: "standards", hardViolation: true as const },
          { ...claimOf("spec1"), axis: "spec" },
        ],
      },
    ]
    const findings = validateFindings({
      findings: [
        { ...findingOf("F1", ["r1:hard1"]), verification: "verified" },
        { ...findingOf("F2", ["r1:spec1"]), verification: "verified" },
        { ...findingOf("F3", []), verification: "verified" },
      ],
    })
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
          { ...claimOf("h"), axis: "standards", hardViolation: true as const },
          { ...claimOf("s"), axis: "spec" },
        ],
      },
    ]
    const raw = validateFindings({
      findings: [
        { ...findingOf("SPEC-LOW", ["r1:s"]), severity: "low", disposition: "follow-up", verification: "verified" },
        { ...findingOf("STD-HIGH", ["r1:h"]), severity: "high", disposition: "fix-now", verification: "verified" },
        { ...findingOf("REJECTED", ["r1:h"]), verification: "false-positive", rejectionReason: "not in diff" },
      ],
    })
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
    suggestedSeverity: "high",
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

describe("tri-review orchestration", () => {
  test("clean first round stops immediately", async () => {
    const result = await runTriReview({
      reviewers: fakeReviewers([[CLAIMS([]), CLAIMS([]), CLAIMS([])]]),
      verifier: fakeVerifier([FINDINGS([])]),
      base: BASE,
      head: HEAD,
      maxRounds: 3,
      timeoutMs: 5_000,
    })
    expect(result.status).toBe("clean")
    expect(result.rounds).toHaveLength(1)
    expect(result.findings).toHaveLength(0)
  })

  test("fix-now findings drive more rounds; resolution reaches clean", async () => {
    const result = await runTriReview({
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
    })
    expect(result.status).toBe("clean")
    expect(result.rounds).toHaveLength(2)
    // Fresh sessions each round: two prompts per reviewer factory.
    expect(result.rounds[1]?.claims).toBe(0)
  })

  test("round limit reports outstanding findings instead of looping forever", async () => {
    const reviewers = fakeReviewers([[CLAIMS(["x"]), CLAIMS([]), CLAIMS([])]])
    const roundsSeen: number[] = []
    const result = await runTriReview({
      reviewers,
      verifier: fakeVerifier([FINDINGS([{ id: "F1", sources: ["opencode:x"], disposition: "fix-now" }])]),
      base: BASE,
      head: HEAD,
      maxRounds: 2,
      timeoutMs: 5_000,
      onRound: (summary) => roundsSeen.push(summary.round),
    })
    expect(result.status).toBe("round-limit")
    expect(result.outstandingFixNow).toEqual(["F1"])
    expect(roundsSeen).toEqual([1, 2])
  })

  test("malformed reviewer output is retried once against the same session", async () => {
    let calls = 0
    const flaky: AgentFactory = {
      id: "flaky",
      fresh: async () => ({
        prompt(input: string) {
          calls += 1
          void input
          return Promise.resolve(calls === 1 ? "not json at all" : CLAIMS(["ok"]))
        },
        abort: async () => {},
        dispose: async () => {},
      }),
    }
    const result = await runTriReview({
      reviewers: [flaky, ...fakeReviewers([[CLAIMS([]), CLAIMS([])]])],
      // The verifier must account for flaky's retried claim.
      verifier: fakeVerifier([FINDINGS([{ id: "F1", sources: ["flaky:ok"], disposition: "skip" }])]),
      base: BASE,
      head: HEAD,
      maxRounds: 1,
      timeoutMs: 5_000,
    })
    expect(calls).toBe(2)
    expect(result.status).toBe("clean")
  })

  test("verifier accounting failure fails loud, never silently drops claims", async () => {
    const result = await runTriReview({
      reviewers: fakeReviewers([[CLAIMS(["c1"]), CLAIMS([]), CLAIMS([])]]),
      // Verifier invents a claim ref and drops the real one.
      verifier: fakeVerifier([FINDINGS([{ id: "F1", sources: ["opencode:nope"], disposition: "skip" }])]),
      base: BASE,
      head: HEAD,
      maxRounds: 3,
      timeoutMs: 5_000,
    })
    expect(result.status).toBe("accounting-failed")
  })

  test("harness-level failure fails fast — no JSON-correction retry", async () => {
    let prompts = 0
    const broken: AgentFactory = {
      id: "broken",
      fresh: async () => ({
        prompt() {
          prompts += 1
          return Promise.reject(new YokeError("opencode", "turn failed", { raw: { finish: "error" } }))
        },
        abort: async () => {},
        dispose: async () => {},
      }),
    }
    const run = runTriReview({
      reviewers: [broken, ...fakeReviewers([[CLAIMS([]), CLAIMS([])]])],
      verifier: fakeVerifier([FINDINGS([])]),
      base: BASE,
      head: HEAD,
      maxRounds: 1,
      timeoutMs: 5_000,
    })
    // The YokeError propagates as-is, not wrapped in "failed to submit valid JSON".
    expect(run).rejects.toThrow(YokeError)
    await run.catch((err: Error) => expect(err.message).toMatch(/turn failed/))
    expect(prompts).toBe(1)
  })

  test("transient harness failure retries on a fresh session until attempts run out", async () => {
    let sessionCount = 0
    const alwaysFlaky: AgentFactory = {
      id: "flaky-provider",
      fresh: async () => {
        sessionCount += 1
        return {
          prompt() {
            throw transientFailure()
          },
          abort: async () => {},
          dispose: async () => {},
        }
      },
    }
    const run = runTriReview({
      reviewers: [alwaysFlaky, ...fakeReviewers([[CLAIMS([]), CLAIMS([])]])],
      verifier: fakeVerifier([FINDINGS([])]),
      base: BASE,
      head: HEAD,
      maxRounds: 1,
      timeoutMs: 5_000,
      backoffMs: () => 0, // no real sleeping in tests; schedule tested separately
    })
    await expect(run).rejects.toThrow(YokeError)
    expect(sessionCount).toBe(5) // MAX_ATTEMPTS, then loud failure
  })

  test("recovers when a later session succeeds after transient failures", async () => {
    const retries: string[] = []
    let sessionCount = 0
    const flaky: AgentFactory = {
      id: "flaky-provider",
      fresh: async () => {
        sessionCount += 1
        const broken = sessionCount <= 2
        return {
          prompt() {
            if (broken) throw transientFailure()
            return Promise.resolve(CLAIMS(["ok"]))
          },
          abort: async () => {},
          dispose: async () => {},
        }
      },
    }
    const result = await runTriReview({
      reviewers: [flaky, ...fakeReviewers([[CLAIMS([]), CLAIMS([])]])],
      verifier: fakeVerifier([FINDINGS([{ id: "F1", sources: ["flaky-provider:ok"], disposition: "skip" }])]),
      base: BASE,
      head: HEAD,
      maxRounds: 1,
      timeoutMs: 5_000,
      onRetry: (message) => retries.push(message),
      backoffMs: () => 0,
    })
    expect(result.status).toBe("clean")
    expect(sessionCount).toBe(3) // two transient failures, third session delivers
    expect(retries).toHaveLength(2)
    expect(retries[0]).toMatch(/attempt 2\/5/)
    expect(retries[1]).toMatch(/attempt 3\/5/)
  })

  test("permanent harness failure never retries", async () => {
    let sessions = 0
    const policyBlocked: AgentFactory = {
      id: "policy-blocked",
      fresh: async () => {
        sessions += 1
        return {
          prompt() {
            throw new YokeError("opencode", "turn failed", {
              raw: { error: { type: "provider.invalid-request", message: "No endpoints available" } },
            })
          },
          abort: async () => {},
          dispose: async () => {},
        }
      },
    }
    const run = runTriReview({
      reviewers: [policyBlocked, ...fakeReviewers([[CLAIMS([]), CLAIMS([])]])],
      verifier: fakeVerifier([FINDINGS([])]),
      base: BASE,
      head: HEAD,
      maxRounds: 1,
      timeoutMs: 5_000,
    })
    await expect(run).rejects.toThrow(YokeError)
    expect(sessions).toBe(1) // one attempt, no fresh-session retry
  })

  test("backoff grows exponentially and caps at two minutes", () => {
    expect(retryBackoffMs(1)).toBe(2_000)
    expect(retryBackoffMs(2)).toBe(8_000)
    expect(retryBackoffMs(3)).toBe(32_000)
    expect(retryBackoffMs(4)).toBe(120_000)
    expect(retryBackoffMs(9)).toBe(120_000)
  })

  test("isTransientTurnFailure classifies real provider errors", () => {
    expect(isTransientTurnFailure(transientFailure())).toBe(true)
    expect(
      isTransientTurnFailure(
        new YokeError("opencode", "turn failed", {
          raw: { error: { type: "provider.invalid-request", message: "guardrail" } },
        }),
      ),
    ).toBe(false)
    expect(isTransientTurnFailure(new Error("plain"))).toBe(false)
  })

  test("hung reviewer turn times out and aborts the whole run loudly", async () => {
    const hung: AgentFactory = {
      id: "hung",
      fresh: async () => scriptedAgent([], { hang: true }),
    }
    const result = runTriReview({
      reviewers: [hung, ...fakeReviewers([[CLAIMS([]), CLAIMS([])]])],
      verifier: fakeVerifier([FINDINGS([])]),
      base: BASE,
      head: HEAD,
      maxRounds: 1,
      timeoutMs: 50,
    })
    expect(result).rejects.toThrow(/timed out/)
  })
})

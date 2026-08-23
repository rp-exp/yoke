import { describe, expect, test } from "bun:test"
import type { AgentFactory, RoundAgent } from "../examples/tri-review-rounds.ts"
import {
  parseJsonReply,
  parsePrRef,
  runTriReview,
  validateClaims,
  validateFindings,
} from "../examples/tri-review-rounds.ts"

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
})

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

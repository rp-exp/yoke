import type { SessionHandle } from "../src/types.ts"

/**
 * Example: PR review rounds driven through three harnesses at once
 * (`yoke/opencode`, `yoke/claude-code`, `yoke/cursor`) plus a verifier turn.
 *
 * Ported from the Claude Code `pr-review-rounds` workflow to show the yoke
 * shape of the same idea: your script is the orchestrator. Reviewers are
 * read-only by prompt (enforcement differs per harness — see DESIGN.md);
 * fixing is deliberately out of scope here, so the example can be pointed at
 * any diff without mutation risk.
 *
 * The orchestration core below is pure over a minimal agent seam so it is
 * unit-testable without any harness installed; only `main()` touches yoke.
 *
 * Run from a checkout of the PR's head:
 *   bun examples/tri-review-rounds.ts <base-sha> <head-sha> [--max-rounds N]
 */

// ---------------------------------------------------------------------------
// Types

export interface Location {
  path: string
  line: number
}

export interface Claim {
  readonly id: string
  readonly title: string
  readonly locations: readonly Location[]
  readonly explanation: string
  readonly suggestedSeverity: string
}

export interface Finding {
  readonly id: string
  readonly title: string
  readonly locations: readonly Location[]
  readonly explanation: string
  readonly sourceClaimReferences: readonly string[]
  readonly verification: string
  readonly rejectionReason?: string | undefined
  readonly decisionReason?: string | undefined
  readonly kind?: string | undefined
  readonly severity?: string | undefined
  readonly disposition?: string | undefined
}

/** One live agent conversation for a single review round. */
export interface RoundAgent {
  prompt(input: string): Promise<string>
  abort(): Promise<void>
  /** Releases the underlying session; refs stay resumable if the factory captured them. */
  dispose(): Promise<void>
}

export interface AgentFactory {
  /** Stable report identity, e.g. "reviewing-cursor". */
  readonly id: string
  /** A fresh session each round: a fresh full review is the only proof that a prior finding is resolved. */
  fresh(): Promise<RoundAgent>
}

const SEVERITIES = new Set(["critical", "high", "medium", "low"])
const DISPOSITIONS = new Set(["fix-now", "follow-up", "skip"])

const LENSES = [
  "correctness and edge cases: error handling, concurrency, invariants, off-by-one, resource lifetimes",
  "spec fidelity and tests: does the change do what it claims, and do the tests actually prove it",
  "maintainability and repo standards: dead code, needless abstraction, naming, standards-doc violations",
]

// ---------------------------------------------------------------------------
// Boundary parsing — external model output is untrusted data; validate hard.

export function parseJsonReply(text: string): unknown {
  const start = text.indexOf("{")
  const end = text.lastIndexOf("}")
  if (start === -1 || end <= start) {
    throw new Error(`reply contains no JSON object: ${text.slice(0, 120).trim()}`)
  }
  return JSON.parse(text.slice(start, end + 1))
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("expected a JSON object")
  }
  return value as Record<string, unknown>
}

function asArray(value: unknown): readonly unknown[] {
  if (!Array.isArray(value)) throw new Error("expected an array")
  return value
}

function str(record: Record<string, unknown>, key: string): string {
  const value = record[key]
  if (typeof value !== "string" || value.length === 0) throw new Error(`missing string field "${key}"`)
  return value
}

function locations(value: unknown): Location[] {
  return asArray(value).map((entry) => {
    const record = asRecord(entry)
    const line = record.line
    if (typeof record.path !== "string" || typeof line !== "number" || !Number.isInteger(line) || line < 1) {
      throw new Error("location needs path:string and integer line>=1")
    }
    return { path: record.path, line }
  })
}

export function validateClaims(value: unknown): Claim[] {
  const claims = asArray(asRecord(value).claims)
  return claims.map((entry) => {
    const record = asRecord(entry)
    const severity = record.suggestedSeverity
    if (typeof severity !== "string" || !SEVERITIES.has(severity)) {
      throw new Error('claim needs suggestedSeverity critical|high|medium|low')
    }
    return {
      id: str(record, "id"),
      title: str(record, "title"),
      locations: locations(record.locations),
      explanation: str(record, "explanation"),
      suggestedSeverity: severity,
    }
  })
}

export function validateFindings(value: unknown): Finding[] {
  const findings = asArray(asRecord(value).findings)
  return findings.map((entry) => {
    const record = asRecord(entry)
    const sources: string[] = []
    for (const ref of asArray(record.sourceClaimReferences)) {
      if (typeof ref !== "string") throw new Error("sourceClaimReferences must be strings")
      sources.push(ref)
    }
    return {
      id: str(record, "id"),
      title: str(record, "title"),
      locations: locations(record.locations),
      explanation: str(record, "explanation"),
      sourceClaimReferences: sources,
      verification: str(record, "verification"),
      rejectionReason: typeof record.rejectionReason === "string" ? record.rejectionReason : undefined,
      decisionReason: typeof record.decisionReason === "string" ? record.decisionReason : undefined,
      kind: typeof record.kind === "string" ? record.kind : undefined,
      severity: typeof record.severity === "string" && SEVERITIES.has(record.severity) ? record.severity : undefined,
      disposition:
        typeof record.disposition === "string" && DISPOSITIONS.has(record.disposition) ? record.disposition : undefined,
    }
  })
}

// ---------------------------------------------------------------------------
// Orchestration core

export interface TriReviewDeps {
  readonly reviewers: readonly AgentFactory[]
  readonly verifier: AgentFactory
  readonly base: string
  readonly head: string
  readonly maxRounds: number
  readonly timeoutMs: number
}

export interface RoundSummary {
  readonly round: number
  readonly claims: number
  readonly findings: readonly Finding[]
}

export interface TriReviewResult {
  readonly status: "clean" | "round-limit" | "accounting-failed"
  readonly rounds: readonly RoundSummary[]
  /** Latest state of every finding ever raised, by stable id. */
  readonly findings: readonly Finding[]
  readonly outstandingFixNow: readonly string[]
}

async function askValidated<T>(
  agent: RoundAgent,
  prompt: string,
  validate: (value: unknown) => T,
  timeoutMs: number,
): Promise<T> {
  let lastError: unknown
  // One retry: models occasionally wrap or malform JSON; two attempts keep
  // flakiness cheap without masking a harness that cannot follow instructions.
  for (let attempt = 1; attempt <= 2; attempt++) {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const reply = await Promise.race([
        agent.prompt(attempt === 1 ? prompt : `${prompt}\n\nYour previous reply was refused (${String(lastError)}). Reply again with ONLY corrected JSON.`),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`turn timed out after ${timeoutMs}ms`)), timeoutMs)
        }),
      ])
      return validate(parseJsonReply(reply))
    } catch (err) {
      lastError = err
      await agent.abort().catch(() => {}) // best effort on timeout races; gate classifies
      if (/timed out/.test(String(err))) throw err
    } finally {
      clearTimeout(timer)
    }
  }
  throw new Error(`agent failed to submit valid JSON twice: ${String(lastError)}`)
}

function accountingErrors(
  reports: readonly { reportID: string; claims: readonly Claim[] }[],
  findings: readonly Finding[],
): string[] {
  const expected = new Set<string>()
  for (const report of reports) for (const claim of report.claims) expected.add(`${report.reportID}:${claim.id}`)
  const seen = new Map<string, number>()
  for (const finding of findings) {
    for (const ref of finding.sourceClaimReferences) seen.set(ref, (seen.get(ref) ?? 0) + 1)
  }
  const errors: string[] = []
  for (const ref of expected) if (!seen.has(ref)) errors.push(`claim ${ref} is not assigned to any finding`)
  for (const [ref, count] of seen) {
    if (!expected.has(ref)) errors.push(`unknown claim reference ${ref}`)
    else if (count > 1) errors.push(`claim ${ref} is assigned ${count} times`)
  }
  return errors
}

const reviewPrompt = (lens: string, base: string, head: string): string =>
  `You are one of several independent reviewers of a change. You are strictly read-only: never edit, create, stage, commit, or delete anything.
Review the COMPLETE diff: git diff ${base}...${head}. Read surrounding code as needed.
Your primary lens: ${lens}. Still report anything important outside it.
Submit evidence only, as claims: what is wrong, where, and why. Do not classify or fix. An empty claims array states you found nothing.
Reply with ONLY a JSON object, no prose:
{"claims":[{"id":"slug","title":"...","locations":[{"path":"src/x.ts","line":10}],"explanation":"why this is wrong","suggestedSeverity":"critical|high|medium|low"}]}`

const verifierPrompt = (round: number, reports: unknown, priorFindings: readonly Finding[]): string =>
  `You are the findings verifier for round ${round} of a multi-round code review. Work read-only; re-read the actual code before deciding.
Anonymous review reports (do not guess which tool produced which):
${JSON.stringify(reports)}

Findings from earlier rounds (stable ids; same underlying issue keeps its id):
${JSON.stringify(priorFindings)}

Rules:
- Merge duplicate claims into one finding; assign EVERY claim of EVERY report exactly once via sourceClaimReferences of the form "<report-id>:<claim-id>". You may add your own findings with an empty array.
- verification "false-positive" requires rejectionReason and omits disposition. Otherwise give decisionReason, kind ("merge-blocker"|"improvement"), severity, disposition ("fix-now"|"follow-up"|"skip").
- An earlier finding no report mentions is resolved: do not restate it.
Reply with ONLY:
{"findings":[{...}]}`

export async function runTriReview(deps: TriReviewDeps): Promise<TriReviewResult> {
  const rounds: RoundSummary[] = []
  let priorFindings: Finding[] = []

  for (let round = 1; round <= deps.maxRounds; round++) {
    // Barrier is deliberate: the verifier needs every report at once.
    const agents = await Promise.all(deps.reviewers.map((factory) => factory.fresh()))
    const reports = await Promise.all(
      deps.reviewers.map(async (factory, i) => {
        const agent = agents[i]
        if (agent === undefined) throw new Error(`missing session for reviewer ${factory.id}`)
        const lens = LENSES[i % LENSES.length]
        if (lens === undefined) throw new Error(`no lens for reviewer ${factory.id}`)
        const claims = await askValidated(agent, reviewPrompt(lens, deps.base, deps.head), validateClaims, deps.timeoutMs)
        return { reportID: factory.id, claims }
      }),
    )

    const verifier = await deps.verifier.fresh()
    let findings: Finding[]
    try {
      findings = await askValidated(verifier, verifierPrompt(round, reports, priorFindings), validateFindings, deps.timeoutMs)
    } finally {
      // Sessions are round-scoped: release them whatever the outcome.
      await Promise.all([...agents, verifier].map((agent) => agent.dispose().then(() => {}, () => {})))
    }

    const errors = accountingErrors(reports, findings)
    if (errors.length > 0) {
      return { status: "accounting-failed", rounds, findings, outstandingFixNow: [] }
    }

    const verified = findings.filter((finding) => finding.verification === "verified")
    priorFindings = verified
    rounds.push({ round, claims: reports.reduce((n, r) => n + r.claims.length, 0), findings })

    if (!verified.some((finding) => finding.disposition === "fix-now")) {
      return { status: "clean", rounds, findings: latestAll(rounds), outstandingFixNow: [] }
    }
  }

  const last = rounds[rounds.length - 1]?.findings ?? []
  return {
    status: "round-limit",
    rounds,
    findings: latestAll(rounds),
    outstandingFixNow: last.filter((f) => f.disposition === "fix-now").map((f) => f.id),
  }
}

function latestAll(rounds: readonly RoundSummary[]): Finding[] {
  const map = new Map<string, Finding>()
  for (const round of rounds) for (const finding of round.findings) map.set(finding.id, finding)
  return [...map.values()]
}

// ---------------------------------------------------------------------------
// Live wiring — the only place real harnesses appear.

async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  const [base, head] = argv
  if (base === undefined || head === undefined) {
    console.error("usage: bun examples/tri-review-rounds.ts <base-sha> <head-sha> [--max-rounds N]")
    process.exit(2)
  }
  const maxRoundsFlag = argv.indexOf("--max-rounds")
  const maxRounds = maxRoundsFlag >= 0 ? Number(argv[maxRoundsFlag + 1]) || 3 : 3
  const cwd = process.cwd()

  // Self-referencing package imports — identical to what a downstream
  // consumer writes after installing yoke from git. Each adapter module
  // registers itself on import; `open` resolves through the shared registry.
  await Promise.all([import("yoke/opencode"), import("yoke/claude-code"), import("yoke/cursor")])
  const { open } = await import("yoke")

  const factories: AgentFactory[] = [
    {
      id: "reviewing-opencode",
      fresh: async () => handleToRoundAgent(await (await open("opencode")).createSession({ cwd })),
    },
    {
      id: "reviewing-claude-code",
      fresh: async () => handleToRoundAgent(await (await open("claude-code")).createSession({ cwd })),
    },
    {
      id: "reviewing-cursor",
      fresh: async () =>
        handleToRoundAgent(await (await open("cursor")).createSession({ cwd, model: "composer-2.5" })),
    },
  ]

  // The verifier runs on one harness; any of them works. Pick opencode for symmetry.
  const verifierFactory = factories[0]
  if (verifierFactory === undefined) throw new Error("no reviewers configured")

  const result = await runTriReview({
    reviewers: factories,
    verifier: verifierFactory,
    base,
    head,
    maxRounds,
    timeoutMs: 15 * 60_000,
  })

  console.log(JSON.stringify(result, null, 2))
  process.exit(result.status === "clean" ? 0 : 1)
}

function handleToRoundAgent(handle: SessionHandle): RoundAgent & { dispose(): Promise<void> } {
  return {
    prompt: async (input) => (await handle.prompt(input)).text,
    abort: () => handle.abort(),
    dispose: () => handle.dispose(),
  }
}

if (import.meta.main) {
  await main()
}

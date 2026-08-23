import type { SessionHandle } from "../src/types.ts"

/**
 * Example: PR review rounds driven through three harnesses at once
 * (`yoke/opencode`, `yoke/claude-code`, `yoke/cursor`) plus a verifier turn.
 *
 * Every reviewer runs the user's battle-tested /code-review procedure (ported
 * from the opencode command into a self-contained prompt, so harnesses without
 * the skill execute it identically): pin the fixed point, find the PR's spec,
 * then report along two separated axes — Standards (repo docs + smell
 * baseline) and Spec. The verifier merges claims per axis; the final report
 * keeps the axes apart, exactly like the skill's aggregate step.
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
 * Run from any clean checkout of the repo; pass a pull request and the script
 * checks it out detached itself (restoring your previous ref afterwards):
 *   bun examples/tri-review-rounds.ts 42
 *   bun examples/tri-review-rounds.ts owner/repo#42 [--max-rounds N]
 * Or point it directly at a diff you already have checked out:
 *   bun examples/tri-review-rounds.ts <base-sha> <head-sha>
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
  /** Which code-review axis the claim belongs to ("standards"|"spec"); kept separate end to end. */
  readonly axis: string
  /** True only for documented-standard breaches; baseline smells and spec gaps are judgement calls. */
  readonly hardViolation?: true
}

export interface Finding {
  readonly id: string
  readonly title: string
  readonly locations: readonly Location[]
  readonly explanation: string
  readonly sourceClaimReferences: readonly string[]
  readonly verification: string
  /** Derived from the sourcing claims, never taken from the verifier. */
  readonly axis?: string | undefined
  readonly hardViolation?: boolean | undefined
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
const AXES = new Set(["standards", "spec"])

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
    const axis = record.axis
    if (typeof axis !== "string" || !AXES.has(axis)) {
      throw new Error('claim needs axis "standards"|"spec"')
    }
    return {
      id: str(record, "id"),
      title: str(record, "title"),
      locations: locations(record.locations),
      explanation: str(record, "explanation"),
      suggestedSeverity: severity,
      axis,
      ...(record.hardViolation === true ? { hardViolation: true } : {}),
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
  /** Called after each round for live progress reporting. */
  onRound?: (summary: RoundSummary) => void
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

// The reviewer prompt is a self-contained port of the user's battle-tested
// /code-review opencode command (the code-review skill): each review agent
// runs the same two-axis procedure regardless of whether its harness has the
// skill installed.

const SMELL_BASELINE = [
  "Mysterious Name — a name that doesn't reveal what it does or holds → rename; no honest name means murky design",
  "Duplicated Code — the same logic shape in more than one hunk or file → extract the shared shape, call it from both",
  "Feature Envy — a method reaching into another object's data more than its own → move it onto the data it envies",
  "Data Clumps — the same few fields or params keep travelling together → bundle them into one type",
  "Primitive Obsession — a primitive standing in for a domain concept → give the concept its own small type",
  "Repeated Switches — the same switch/if-cascade on the same type recurs → polymorphism, or one shared map",
  "Shotgun Surgery — one logical change forces scattered edits across many files → gather what changes into one module",
  "Divergent Change — one module edited for several unrelated reasons → split so each changes for one reason",
  "Speculative Generality — abstraction or hooks for needs the spec doesn't have → delete; inline until a real need shows",
  "Message Chains — long a.b().c().d() navigation → hide the walk behind one method on the first object",
  "Middle Man — a class or function that mostly delegates onward → cut it, call the target direct",
  "Refused Bequest — an implementer ignoring most of what it inherits → drop the inheritance, use composition",
].map((line) => `   - ${line}`).join("\n")

/**
 * Findings inherit their axis from the claims they source — never from the
 * verifier's say-so. Axis of the first source wins; hardViolation is
 * contagious (a smell merged into a documented-standard breach stays hard).
 */
export function assignAxes(
  reports: readonly { reportID: string; claims: readonly Claim[] }[],
  findings: readonly Finding[],
): Finding[] {
  const byRef = new Map<string, Claim>()
  for (const report of reports) for (const claim of report.claims) {
    byRef.set(`${report.reportID}:${claim.id}`, claim)
  }
  return findings.map((finding) => {
    const sources = finding.sourceClaimReferences
      .map((ref) => byRef.get(ref))
      .filter((claim) => claim !== undefined)
    return {
      ...finding,
      axis: sources[0]?.axis,
      hardViolation: sources.some((claim) => claim.hardViolation === true) ? true : undefined,
    }
  })
}

export const reviewPrompt = (base: string, head: string): string =>
  `You are an independent reviewer executing this code-review procedure exactly. You are strictly read-only: never edit, create, stage, commit, or delete anything.
The change under review — fixed point already validated:
- diff: git diff ${base}...${head}
- commits: git log ${base}..${head} --oneline

Procedure:
1. Run both commands and confirm the diff is non-empty. An empty diff means an empty claims array.
2. Identify the spec, in this order: (a) issue references in the commit messages ("#123", "Closes #45") — open them if your tools allow; (b) a spec file under docs/, specs/, or .scratch/ matching the branch or feature. If nothing is found, skip the Spec axis entirely.
3. Identify standards sources: anything in the repo documenting how code should be written (CODING_STANDARDS.md, CONTRIBUTING.md, AGENTS.md, ...). Documented repo standards override the smell baseline below, and anything tooling already enforces is skipped.
4. Review along two separate axes:
   - Standards: every place the diff violates a documented standard — cite the file and the rule, and mark such claims "hardViolation":true (the only case where that flag may be set); plus any baseline smell you spot — name it and quote the hunk. Baseline smells are always judgement calls, never hard violations.
   - Spec: requirements the spec asked for but are missing or partial; behaviour nobody asked for (scope creep); implementations that look wrong. Quote the spec line for each Spec claim.
5. Submit evidence as claims: what is wrong, where, why, which axis. Do not classify disposition and do not propose fixes. An empty claims array states you found nothing.

Smell baseline (what it is → how to fix):
${SMELL_BASELINE}

Reply with ONLY a JSON object, no prose:
{"claims":[{"id":"slug","title":"...","locations":[{"path":"src/x.ts","line":10}],"explanation":"why this is wrong","suggestedSeverity":"critical|high|medium|low","axis":"standards|spec","hardViolation":true}]}`

const verifierPrompt = (round: number, reports: unknown, priorFindings: readonly Finding[]): string =>
  `You are the findings verifier for round ${round} of a multi-round code review. Work read-only; re-read the actual code before deciding.
Anonymous review reports (do not guess which tool produced which):
${JSON.stringify(reports)}

Findings from earlier rounds (stable ids; same underlying issue keeps its id):
${JSON.stringify(priorFindings)}

Rules:
- Merge duplicate claims into one finding; assign EVERY claim of EVERY report exactly once via sourceClaimReferences of the form "<report-id>:<claim-id>". You may add your own findings with an empty array.
- Never merge claims from different axes into one finding.
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
        const claims = await askValidated(agent, reviewPrompt(deps.base, deps.head), validateClaims, deps.timeoutMs)
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
    const withAxes = assignAxes(reports, findings)

    const verified = withAxes.filter((finding) => finding.verification === "verified")
    priorFindings = verified
    const summary: RoundSummary = { round, claims: reports.reduce((n, r) => n + r.claims.length, 0), findings: withAxes }
    rounds.push(summary)
    deps.onRound?.(summary)

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

const SEVERITY_ORDER = ["critical", "high", "medium", "low"] as const

function bySeverityDesc(a: Finding, b: Finding): number {
  const rank = (f: Finding) => {
    const i = SEVERITY_ORDER.indexOf((f.severity ?? "low") as (typeof SEVERITY_ORDER)[number])
    return i === -1 ? SEVERITY_ORDER.length : i
  }
  return rank(a) - rank(b)
}

/**
 * The code-review skill's aggregate step: the two axes presented separately,
 * never merged or reranked across axes, one summary line per axis naming its
 * worst issue.
 */
export function renderReport(result: TriReviewResult): string {
  const sections: string[] = []
  for (const axis of ["standards", "spec"]) {
    const items = result.findings
      .filter((f) => f.axis === axis && f.verification === "verified")
      .sort(bySeverityDesc)
    const heading = axis === "standards" ? "## Standards" : "## Spec"
    if (items.length === 0) {
      sections.push(`${heading}\n\nNo findings.`)
      continue
    }
    const body = items.map((f) => {
      const where = f.locations.map((l) => `${l.path}:${l.line}`).join(", ")
      const hard = f.hardViolation === true ? " [hard violation]" : ""
      const disposition = f.disposition !== undefined ? ` (${f.disposition}${f.severity ? `, ${f.severity}` : ""})` : ""
      return `### ${f.id}: ${f.title}${hard}\n- at: ${where}\n${f.explanation}\n- verdict:${disposition}`
    })
    const worst = items.find((f) => f.disposition === "fix-now") ?? items[0]
    const worstLine =
      worst === undefined
        ? "No findings."
        : `**Worst:** ${worst.id} — ${worst.title} (${worst.severity ?? "unranked"})`
    sections.push(`${heading}\n\n${body.join("\n\n")}\n\n${items.length} finding(s). ${worstLine}`)
  }
  return sections.join("\n\n")
}

// ---------------------------------------------------------------------------
// Live wiring — the only place real harnesses and git/gh appear.

export interface PrRef {
  /** owner/repo when the reference carried it; otherwise gh resolves from cwd. */
  readonly repo?: string
  readonly number: string
}

/** Accepts "42", "#42", "owner/repo#42", or a github.com pull request URL. */
export function parsePrRef(raw: string): PrRef {
  const value = raw.trim()
  const url = value.match(/^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/)
  if (url !== null && url[1] !== undefined && url[2] !== undefined) {
    return { repo: url[1], number: url[2] }
  }
  const short = value.match(/^(?:([\w.-]+\/[\w.-]+))?#?(\d+)$/)
  if (short !== null && short[2] !== undefined) {
    return short[1] !== undefined ? { repo: short[1], number: short[2] } : { number: short[2] }
  }
  throw new Error(`cannot parse PR reference ${JSON.stringify(raw)} (try "42", "#42", "owner/repo#42" or a PR URL)`)
}

/** Runs a command, failing loudly with its stderr. Never inherits stdio. */
function sh(cmd: readonly string[]): string {
  const proc = Bun.spawnSync([...cmd], { stdout: "pipe", stderr: "pipe" })
  if (proc.exitCode !== 0) {
    throw new Error(`${cmd.join(" ")} failed (${proc.exitCode}): ${proc.stderr.toString().trim()}`)
  }
  return proc.stdout.toString().trim()
}

interface PreparedPr {
  readonly url: string
  readonly base: string
  readonly head: string
  readonly previousRef: string
  readonly repoArg: readonly string[]
}

function preparePr(ref: PrRef): PreparedPr {
  const repoArg = ref.repo !== undefined ? ["--repo", ref.repo] : []
  const dirty = sh(["git", "status", "--porcelain"])
  if (dirty !== "") {
    throw new Error(`working tree is dirty — commit or stash before reviewing:\n${dirty}`)
  }
  const branch = Bun.spawnSync(["git", "symbolic-ref", "--short", "HEAD"], { stdout: "pipe", stderr: "pipe" })
  // Detached HEAD has no branch name; the SHA restores just as well.
  const previousRef =
    branch.exitCode === 0 ? branch.stdout.toString().trim() : sh(["git", "rev-parse", "HEAD"])

  sh(["gh", "pr", "checkout", ref.number, "--detach", ...repoArg])
  const view = sh(["gh", "pr", "view", ref.number, "--json", "url,baseRefOid,headRefOid", ...repoArg])
  const info = JSON.parse(view) as { url: string; baseRefOid: string; headRefOid: string }
  console.log(`reviewing ${info.url} at ${info.headRefOid.slice(0, 10)} (base ${info.baseRefOid.slice(0, 10)})`)
  return { url: info.url, base: info.baseRefOid, head: info.headRefOid, previousRef, repoArg }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2)
  const positional: string[] = []
  let maxRounds = 3
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--max-rounds") {
      maxRounds = Number(argv[i + 1])
      if (!Number.isInteger(maxRounds) || maxRounds < 1) throw new Error("--max-rounds needs a positive integer")
      i += 1
    } else {
      positional.push(argv[i] as string)
    }
  }

  await Promise.all([import("yoke/opencode"), import("yoke/claude-code"), import("yoke/cursor")])
  const { open } = await import("yoke")

  let prepared: PreparedPr | undefined
  let base: string
  let head: string
  if (positional.length === 1) {
    prepared = preparePr(parsePrRef(positional[0] as string))
    base = prepared.base
    head = prepared.head
  } else if (positional.length === 2) {
    ;[base, head] = positional as [string, string]
  } else {
    console.error(
      "usage: bun examples/tri-review-rounds.ts <pr> [--max-rounds N]\n" +
        "       bun examples/tri-review-rounds.ts <base-sha> <head-sha>\n" +
        '       <pr> is "42", "#42", "owner/repo#42", or a github.com PR URL',
    )
    process.exit(2)
  }
  const cwd = process.cwd()

  const factories: AgentFactory[] = [
    {
      id: "reviewing-opencode",
      fresh: async () =>
        handleToRoundAgent(
          await (await open("opencode")).createSession({ cwd, model: "opencode-go/ox-alpha-free", effort: "high" }),
        ),
    },
    {
      id: "reviewing-cursor",
      fresh: async () =>
        handleToRoundAgent(
          await (await open("cursor")).createSession({ cwd, model: "grok-4.6", effort: "high" }),
        ),
    },
    {
      id: "reviewing-claude-code",
      fresh: async () =>
        handleToRoundAgent(await (await open("claude-code")).createSession({ cwd, model: "opus", effort: "high" })),
    },
  ]

  // Everything else (the verifier) runs on the opencode harness default —
  // whatever provider/model/effort the service currently resolves, no pinning.
  const verifierFactory: AgentFactory = {
    id: "verifying-opencode",
    fresh: async () => handleToRoundAgent(await (await open("opencode")).createSession({ cwd })),
  }

  let result: Awaited<ReturnType<typeof runTriReview>>
  try {
    result = await runTriReview({
      reviewers: factories,
      verifier: verifierFactory,
      base,
      head,
      maxRounds,
      timeoutMs: 15 * 60_000,
      onRound: ({ round, claims, findings }) => {
        const fixNow = findings.filter((f) => f.disposition === "fix-now").length
        console.log(`round ${round}: ${claims} claims, ${findings.length} findings (${fixNow} fix-now)`)
      },
    })
  } finally {
    // The review is read-only, so whatever gh checked out can always go back.
    if (prepared !== undefined) sh(["git", "checkout", prepared.previousRef])
  }

  console.log(renderReport(result))
  if (result.status === "round-limit") {
    console.error(`\nround limit hit with outstanding fix-now findings: ${result.outstandingFixNow.join(", ")}`)
  }
  if (result.status === "accounting-failed") {
    console.error("\naccounting failed: the verifier mis-assigned claims — see result JSON in the transcript")
  }
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

import { z } from "zod"
import { agent, runWorkflow, type Agent, type TurnOptions } from "../src/workflow.ts"

/**
 * Example: PR review rounds — two reviewers (`yoke/cursor`,
 * `yoke/claude-code`) in parallel plus an Opus 5 verifier turn on
 * `yoke/claude-code` —
 * written on the workflow layer (src/workflow.ts). Reviewers and the verifier
 * are `agent()` values; every turn is a `Conversation.ask()`, so the layer
 * owns the timeout, retry, and reply-contract machinery this file used to
 * carry itself. What remains here is purely the review-rounds domain: schemas,
 * prompts, claim accounting, axis derivation, rounds, and the report.
 *
 * Every reviewer executes the user's battle-tested /code-review procedure by
 * following their locally installed code-review skill — the prompt delegates
 * to the skill (like the opencode command does) instead of copying it, so the
 * skill keeps evolving outside this file. The verifier merges claims per
 * axis; the final report keeps the axes apart, like the skill's aggregate.
 *
 * Reviewers are read-only by prompt (enforcement differs per harness — see
 * DESIGN.md); fixing is deliberately out of scope here, so the example can be
 * pointed at any diff without mutation risk.
 *
 * Run from any clean checkout of the repo; pass a pull request and the script
 * checks it out detached itself (restoring your previous ref afterwards):
 *   bun examples/review-rounds.ts 42
 *   bun examples/review-rounds.ts owner/repo#42 [--max-rounds N]
 * Or point it directly at a diff you already have checked out:
 *   bun examples/review-rounds.ts <base-sha> <head-sha>
 */

// ---------------------------------------------------------------------------
// Schemas — external model output is untrusted data; validated by `ask` at
// the boundary, and `ask` states each reply contract from the schema itself.

const Location = z.object({ path: z.string().min(1), line: z.number().int().min(1) })

const Severity = z.enum(["critical", "high", "medium", "low"])

const Axis = z.enum(["standards", "spec"])

const Verification = z.enum(["verified", "false-positive"])

const Kind = z.enum(["merge-blocker", "improvement"])

export const Claim = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  locations: z.array(Location),
  explanation: z.string().min(1),
  suggestedSeverity: Severity,
  /** Which code-review axis the claim belongs to; kept separate end to end. */
  axis: Axis,
  /** True only for documented-standard breaches; baseline smells and spec gaps are judgement calls. */
  hardViolation: z.literal(true).optional(),
})
export type Claim = z.infer<typeof Claim>

export const Claims = z.object({ claims: z.array(Claim) })

const FindingBase = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  locations: z.array(Location),
  explanation: z.string().min(1),
  sourceClaimReferences: z.array(z.string().min(1)),
  verification: Verification,
  rejectionReason: z.string().optional(),
  decisionReason: z.string().optional(),
  kind: Kind.optional(),
  severity: Severity.optional(),
  disposition: z.enum(["fix-now", "follow-up", "skip"]).optional(),
})

export const Findings = z.object({ findings: z.array(FindingBase) })

/** A verifier finding enriched with the axis derived from its sourcing claims. */
export interface Finding extends z.infer<typeof FindingBase> {
  /** Derived from the sourcing claims, never taken from the verifier. */
  readonly axis?: z.infer<typeof Axis> | undefined
  readonly hardViolation?: boolean | undefined
}

interface Report {
  readonly reportID: string
  readonly claims: readonly Claim[]
}

// ---------------------------------------------------------------------------
// Domain logic

function accountingErrors(reports: readonly Report[], findings: readonly Finding[]): string[] {
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

/**
 * Findings inherit their axis from the claims they source — never from the
 * verifier's say-so. Axis of the first source wins; hardViolation is
 * contagious (a smell merged into a documented-standard breach stays hard).
 */
export function assignAxes(reports: readonly Report[], findings: readonly Finding[]): Finding[] {
  const byRef = new Map<string, Claim>()
  for (const report of reports)
    for (const claim of report.claims) {
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

// ---------------------------------------------------------------------------
// Prompts — each delegates procedure to the agent's installed skill and adds
// only the orchestration contract; the reply schema is stated by `ask`.

export const reviewPrompt = (base: string, head: string): string =>
  `Review the change at ${head} since fixed point ${base} by following the \`code-review\` skill (load it via the skill tool if you haven't).
- Diff: git diff ${base}...${head}. Commits: git log ${base}..${head} --oneline. Both are pre-validated; an empty diff means an empty claims array.
- You are strictly read-only: never edit, create, stage, commit, or delete anything.
- Report every finding as a claim (id: a short stable slug) tagged with the code-review axis it belongs to: "standards" or "spec". Set "hardViolation":true only where the skill treats something as a documented-standard breach, not for judgement-call smells.`

const verifierPrompt = (round: number, reports: readonly Report[], priorFindings: readonly Finding[]): string =>
  `You are the findings verifier for round ${round} of a multi-round code review. Work read-only; re-read the actual code before deciding.
Anonymous review reports (do not guess which tool produced which):
${JSON.stringify(reports)}

Findings from earlier rounds (stable ids; same underlying issue keeps its id):
${JSON.stringify(priorFindings)}

Rules:
- Merge duplicate claims into one finding; assign EVERY claim of EVERY report exactly once via sourceClaimReferences of the form "<report-id>:<claim-id>". You may add your own findings with an empty array.
- Never merge claims from different axes into one finding.
- verification "false-positive" requires rejectionReason and omits disposition. Otherwise give decisionReason, kind ("merge-blocker"|"improvement"), severity, disposition ("fix-now"|"follow-up"|"skip").
- An earlier finding no report mentions is resolved: do not restate it.`

// ---------------------------------------------------------------------------
// Orchestration

export interface ReviewRoundsDeps {
  readonly reviewers: readonly Agent[]
  readonly verifier: Agent
  readonly base: string
  readonly head: string
  readonly maxRounds: number
  readonly timeoutMs: number
  /** Called after each round for live progress reporting. */
  readonly onRound?: (summary: RoundSummary) => void
  /** Forwarded to every turn; defaults to console.error. */
  readonly onRetry?: (message: string) => void
  /** Forwarded to every turn; injectable so tests never sleep. */
  readonly backoffMs?: (attempt: number) => number
}

export interface RoundSummary {
  readonly round: number
  readonly claims: number
  readonly findings: readonly Finding[]
}

export interface ReviewRoundsResult {
  readonly status: "clean" | "round-limit" | "accounting-failed"
  readonly rounds: readonly RoundSummary[]
  /** Latest state of every finding ever raised, by stable id. */
  readonly findings: readonly Finding[]
  readonly outstandingFixNow: readonly string[]
}

export async function runReviewRounds(deps: ReviewRoundsDeps): Promise<ReviewRoundsResult> {
  // Reviewer and verifier turns are read-only, so repeating one on a fresh
  // session is safe — that idempotency judgment belongs to this workflow,
  // which is why the policy is set on the turns here rather than assumed.
  const turnOpts: TurnOptions = {
    timeoutMs: deps.timeoutMs,
    retries: "transient",
    ...(deps.onRetry !== undefined ? { onRetry: deps.onRetry } : {}),
    ...(deps.backoffMs !== undefined ? { backoffMs: deps.backoffMs } : {}),
  }

  const rounds: RoundSummary[] = []
  let priorFindings: Finding[] = []

  for (let round = 1; round <= deps.maxRounds; round++) {
    // Fresh conversations every round: a fresh full review is the only proof
    // a prior finding is resolved. The barrier is deliberate: the verifier
    // needs every report at once. Each conversation is disposed when its turn
    // finishes, so at most one round's sessions are live at once.
    const reports: Report[] = await Promise.all(
      deps.reviewers.map(async (reviewer) => {
        const conversation = reviewer.open()
        try {
          const claims = (await conversation.ask(reviewPrompt(deps.base, deps.head), Claims, turnOpts)).claims
          return { reportID: reviewer.id, claims }
        } finally {
          await conversation.dispose()
        }
      }),
    )

    const verifierConversation = deps.verifier.open()
    let raw: z.infer<typeof Findings>
    try {
      raw = await verifierConversation.ask(verifierPrompt(round, reports, priorFindings), Findings, turnOpts)
    } finally {
      await verifierConversation.dispose()
    }

    const errors = accountingErrors(reports, raw.findings)
    if (errors.length > 0) {
      return { status: "accounting-failed", rounds, findings: raw.findings, outstandingFixNow: [] }
    }
    const withAxes = assignAxes(reports, raw.findings)

    const verified = withAxes.filter((finding) => finding.verification === "verified")
    priorFindings = verified
    const summary: RoundSummary = {
      round,
      claims: reports.reduce((n, r) => n + r.claims.length, 0),
      findings: withAxes,
    }
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
  const rank = (f: Finding): number => SEVERITY_ORDER.indexOf(f.severity ?? "low")
  return rank(a) - rank(b)
}

/**
 * The code-review skill's aggregate step: the two axes presented separately,
 * never merged or reranked across axes, one summary line per axis naming its
 * worst issue.
 */
export function renderReport(result: ReviewRoundsResult): string {
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

// `gh` output is external data — validated at the boundary before use.
const PrView = z.object({
  url: z.string().min(1),
  baseRefOid: z.string().min(1),
  headRefOid: z.string().min(1),
})

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
  const info = PrView.parse(JSON.parse(view))
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

  // Adapters self-register on import; agent() then resolves them by id.
  await Promise.all([import("yoke/claude-code"), import("yoke/cursor")])

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
      "usage: bun examples/review-rounds.ts <pr> [--max-rounds N]\n" +
        "       bun examples/review-rounds.ts <base-sha> <head-sha>\n" +
        '       <pr> is "42", "#42", "owner/repo#42", or a github.com PR URL',
    )
    process.exit(2)
  }

  const reviewers = [
    agent("reviewing-cursor", { harness: "cursor", model: "grok-4.6", effort: "high" }),
    agent("reviewing-claude-code", { harness: "claude-code", model: "claude-opus-5", effort: "high" }),
  ]
  const verifier = agent("verifying-claude-code", { harness: "claude-code", model: "claude-opus-5", effort: "high" })

  let result: ReviewRoundsResult
  try {
    result = await runWorkflow(() =>
      runReviewRounds({
        reviewers,
        verifier,
        base,
        head,
        maxRounds,
        timeoutMs: 15 * 60_000,
        onRound: ({ round, claims, findings }) => {
          const fixNow = findings.filter((f) => f.disposition === "fix-now").length
          console.log(`round ${round}: ${claims} claims, ${findings.length} findings (${fixNow} fix-now)`)
        },
      }),
    )
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

if (import.meta.main) {
  await main()
}

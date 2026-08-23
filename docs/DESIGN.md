# Yoke design

Decisions, per-harness facts, and open questions. Read this before implementing an
adapter or changing the public interface.

## v1 scope

Turn-based core only:

```ts
/**
 * Grows as adapters land. MVP covers these three; Codex and Pi are deferred
 * (see "MVP scope") and their ids get added back when their adapters exist.
 */
type HarnessId = "opencode" | "claude-code" | "cursor"

declare const refBrand: unique symbol
/** Opaque token. Persist verbatim, pass back verbatim; parsing it is unsupported. */
type SessionRef = string & { readonly [refBrand]: never }

interface Harness {
  readonly id: HarnessId
  createSession(opts: SessionOptions): Promise<SessionHandle>
}

interface SessionOptions {
  cwd: string
  /** Pass a ref from serialize() to resume instead of starting fresh. */
  sessionRef?: SessionRef
  /**
   * Opaque model string in the harness's native vocabulary (e.g. "provider/model").
   * Pass-through only — never a registry; omit to use the harness's own default.
   */
  model?: string
}

interface SessionHandle {
  /** Send a prompt; resolves when the agent finishes the turn. */
  prompt(input: string): Promise<TurnResult>
  /** Round-trip into createSession({ sessionRef }) to resume. */
  serialize(): Promise<SessionRef>
  abort(): Promise<void>
  dispose(): Promise<void>
}

interface TurnResult {
  text: string   // final assistant message
  raw: unknown   // harness-native result, escape hatch
}
```

Explicitly out of v1:

- Streaming-event normalization. If needed later: `events?: AsyncIterable<RawEvent>`
  as raw passthrough — never a unified event schema.
- Permissions/approval abstraction. Configure each harness natively.
- Model-name registry. Model strings pass through opaquely.
- Auth unification. Pass-through only.

## MVP scope

Three adapters, in build order: **OpenCode (V2)** → **Claude Code** → **Cursor**.
Together they cover the three architecture shapes (HTTP service, subprocess CLI,
cloud/local SDK) without redundancy.

Deferred, deliberately — revisit only when a real workflow needs them:

- **Pi** — in-process model forces one structural concession; no workflow demands it yet.
- **Codex** — CLI-wrapper shape already exercised by the Claude Code adapter.

## Session refs

Rules:

- Refs are opaque. Workflows persist and replay them byte-for-byte; adapters must
  not require them to be interpretable. Branded as `string & unique symbol` so a
  raw string can't sneak into `createSession` untyped.
- `serialize()` is not single-use: one ref may be resumed any number of times.
- Resuming **transfers ownership**. After `createSession({ sessionRef })`, the new
  handle owns the session; prompting the old handle afterwards is a programming
  error (rejects with `HandleBusyError` when detectable in-process; undefined
  across processes — don't).
- Refs are same-machine only. They may embed local paths and account state;
  cross-machine portability is out of v1.

Durability contract — every adapter declares its tier up front, and the shared
conformance suite enforces exactly what it declares:

| Tier | Meaning | Expected by harness |
|---|---|---|
| A — cross-process | Ref resumes in a fresh process on the same machine | OpenCode (service persists sessions), Claude Code (`resume: sessionId`), Cursor local (SDK checkpoint store) |
| B — in-process only | Ref valid until the orchestrator process exits | Pi `inMemory()` mode (deferred) |

An adapter whose harness cannot support cross-process resume must still return a
ref from `serialize()` (tier B) — it never throws for lack of durability. The tier,
not the call site, tells the workflow what it can rely on.

## Packaging & runtime

- **Single package.** Per-harness subpath exports (`yoke/opencode`, …); each
  harness SDK is an optional peerDependency, so users install only the adapters
  they use. `open()` on a harness whose SDK is missing fails loudly, naming the
  package to install.
- Adapters live in `src/adapters/<harness>/` behind an internal registry seam so
  a later split into workspace packages stays mechanical.
- **Runtime: Bun** — built-in `bun:test`, keeping dev dependencies at zero.

## Failure contract

`prompt()` has exactly two outcomes: it resolves with the complete final message,
or it rejects. It never resolves with truncated or partial text — deterministic
scripts branch on results, and silent truncation corrupts everything downstream.

Errors are subclasses of one root, so workflows can catch broadly or narrowly:

```ts
class YokeError extends Error {
  readonly harnessId: HarnessId
  readonly raw: unknown // harness-native error object; same escape hatch as TurnResult.raw
}
class TurnAbortedError extends YokeError {}        // abort() landed during this turn
class HandleBusyError extends YokeError {}         // concurrent prompt() / mid-turn serialize()
class HandleDisposedError extends YokeError {}     // prompt() after dispose()
class HarnessUnavailableError extends YokeError {} // spawn/connect to the harness failed
```

- **Permission/approval outcomes** that a harness models as a *finished* turn come
  back as normal `TurnResult`s — yoke does not normalize approvals (v1 scope).
  Scripts that care inspect `raw`.
- **`abort()`** makes the in-flight `prompt()` reject with `TurnAbortedError`. Whether
  the session survives an abort is per-harness; each adapter documents it, and if
  the session is dead, the next `prompt()` fails loudly (`HarnessUnavailableError`
  or the native error in `raw`) — never hangs.
- **`dispose()`** releases local resources (subprocesses, connections). It does not
  destroy the persisted session — a tier-A ref stays resumable. Idempotent.
  Called during an in-flight turn it aborts first, then disposes. Any later
  `prompt()` rejects with `HandleDisposedError`.
- **`serialize()` during an in-flight turn** rejects with `HandleBusyError`:
  mid-turn snapshot semantics differ per harness and aren't worth normalizing.
- **Timeouts are not yoke's job.** No default timeout, ever — a hidden kill switch
  is worse than none. Workflows set their own timer and call `abort()`.

## Concurrency

One in-flight prompt per handle. A second concurrent `prompt()` rejects immediately
with `HandleBusyError` rather than queueing — queueing would make per-harness
ordering differences invisible until they bite. `abort()`, `dispose()`, and
`serialize()` (per above) are the only calls valid mid-turn.

## Build order

1. OpenCode V2 — first: the dogfooding target (orchestrator author runs V2 locally);
   exercises the HTTP-service shape.
2. Claude Code — subprocess shape; the harness dynamic workflows were born on.
3. Cursor — cloud/local duality smell-tests the abstraction.

YAGNI check before writing any adapter: confirm the workflow that needs it exists.

## Per-harness facts

| Harness | Package | Architecture | Gotchas |
|---|---|---|---|
| OpenCode (V2) | `@opencode-ai/client` | HTTP client → shared background service (`opencode2`) | Service lifecycle: `opencode2 service status/restart`; OpenAPI at server `/openapi.json`; sessions survive the orchestrator process |
| Claude Code | `@anthropic-ai/claude-agent-sdk` | Spawns CLI subprocess per turn (`query()`), one `result` message per turn | Session ids pre-assigned via `options.sessionId` so refs serialize before the first turn; a ref only becomes resumable once a turn persists its JSONL — unresumable refs fail loudly at prompt time. Headless sessions auto-deny permission prompts; slow turns must be tool-free |
| Cursor | `@cursor/sdk` | Local: `Agent.create({ local })` → `send()` → `wait()`; cloud deferred | Refs `cursor:v1:<agentId>` are tier A via the SDK's persisted checkpoint store (resumable across processes). Model is **required** — local agents have no default. Abort = `run.cancel()` → status `cancelled` |
| Codex *(deferred)* | `@openai/codex-sdk` | Wraps CLI, JSONL over stdin/stdout | Node ≥ 18; `startThread()` / `run()` / `runStreamed()`; threads persist in `~/.codex/sessions`, `resumeThread(id)`; requires git repo unless `skipGitRepoCheck: true` |
| Pi *(deferred)* | `@earendil-works/pi-coding-agent` | In-process library, no subprocess | `createAgentSession()`, `session.prompt()`, `session.steer()`; `SessionManager.inMemory()/create(cwd)/continueRecent/open(path)`; sessions are tree-structured JSONL; forking via `AgentSessionRuntime` |

Docs base for OpenCode V2: <https://opencode.ai/v2/docs/> — V2 only; never consult
the V1 docs at `opencode.ai/docs` for V2 questions.

## Known friction, ranked

1. **Auth/account models** — expected ~80% of support burden. Claude: OAuth/Max
   subscription or API key. Codex: ChatGPT login or `CODEX_API_KEY`. Cursor: own
   key. OpenCode/Pi read their own config dirs. Pass-through; cannot unify.
2. **Permissions/sandboxing** — irreducibly different: Codex git-repo requirement,
   Claude permission modes, Cursor cloud auto-approve, OpenCode config permissions.
3. **Model naming vocabularies** differ per harness.
4. **Event schemas** differ per harness — ignored in v1 by design.

## Open questions

1. Does `prompt()` need multi-part/image input in v1, or string-only? Design assumed string-only.
2. Concurrency/rate-limit policy assumed to be the workflow's job, not yoke's.

Resolved:

- Repo/package layout → single package with subpath exports + optional peers (see "Packaging & runtime").
- Runtime target → Bun.

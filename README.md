# yoke

One interface for driving coding-agent harnesses from your own code.

A yoke links draft animals to a harness so they pull in unison. This yoke links
agent **harnesses** to your workflows, so you write the orchestration once and run
it against any of them.

**Status: pre-alpha.** The interface below is the design target; adapters are being
built harness by harness. See [docs/DESIGN.md](docs/DESIGN.md) for scope and
progress.

## Why

Claude Code ships *dynamic workflows*: deterministic JS scripts that fan work out
across many agent sessions. Every serious harness now exposes similar primitives
through an SDK — but each through its own API shape, session model, and lifecycle.
Skills (`SKILL.md`) standardized the instructions layer across harnesses; nothing
standardizes orchestration.

Yoke is that missing layer: a thin adapter with one small interface per harness.

## Design target

```ts
import { open } from "yoke"

const claude = await open("claude-code")

const session = await claude.createSession({ cwd: process.cwd() })
const result = await session.prompt("List every TODO in src/ and group by owner")
console.log(result.text)

const ref = await session.serialize() // opaque; resume later or in another process
```

The core is deliberately turn-based: create a session, send a prompt, get the final
result. Concurrency limits, retries, and fan-out are ordinary code you write on top.

## Harnesses

| Harness | Adapter status | Backed by |
|---|---|---|
| OpenCode (V2) | **MVP — first** | `@opencode-ai/client` |
| Claude Code | MVP — next | `@anthropic-ai/claude-agent-sdk` |
| Cursor | MVP — planned | `@cursor/sdk` |
| Codex | deferred | `@openai/codex-sdk` |
| Pi | deferred | `@earendil-works/pi-coding-agent` |

The MVP three cover all three adapter architectures (HTTP service, subprocess CLI,
cloud/local SDK). Codex and Pi are deliberately deferred until a real workflow
needs them — see [docs/DESIGN.md](docs/DESIGN.md#mvp-scope).

## What yoke does not do

- **Normalize auth.** Each harness keeps its own login/API-key story; yoke passes through.
- **Normalize permissions or sandboxing.** Configure each harness natively.
- **Normalize streaming events.** v1 returns final results only; raw events may be exposed later as passthrough.
- **Registry model names.** Model strings pass through opaquely.

These are irreducibly per-harness; abstracting them would trade real differences for
a leaky fiction. See [docs/DESIGN.md](docs/DESIGN.md) for the reasoning.

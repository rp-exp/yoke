# AGENTS.md

Yoke: one TypeScript interface over coding-agent harnesses so deterministic
workflow scripts can be written once and driven by any of them. The MVP targets
OpenCode (V2), Claude Code, and Cursor; Codex and Pi are deliberately deferred.
Pre-alpha.

## Read first

- [docs/DESIGN.md](docs/DESIGN.md) — read before implementing an adapter, changing
  the public interface, or adding a dependency.
- Scope questions resolve against the v1 list in DESIGN.md. If a change would move
  something into or out of scope (events, permissions, auth, model names), stop and
  ask — those boundaries were chosen deliberately.

## Working rules

- Test-first: failing test → make it pass → refactor. Every adapter gets unit tests
  against its SDK's types plus one thin integration test; nothing else ships untested.
- Strict types everywhere, zero `any` — including adapter boundaries where SDK types
  tempt you to loosen them. `TurnResult.raw` is the only sanctioned escape hatch.
- Validate at boundaries: parse harness responses and session refs before use; fail
  fast and loud. No silent fallbacks, no swallowed exceptions.
- Immutable data, pure functions, side effects at the edges (process spawning, HTTP).
- Small single-purpose functions and files. Comments explain *why* only.
- Keep diffs on-task. Report nearby problems without fixing them.

## Dependencies

Ask before adding any dependency, every time. Each adapter pulls in a heavyweight
SDK package — name the exact package and version in the ask.

## Git

Feature branches; commit and push freely there. Changes to `main` and any history
rewrite need explicit approval.

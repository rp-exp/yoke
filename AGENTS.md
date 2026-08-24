# AGENTS.md

Yoke: one TypeScript interface over coding-agent harnesses so deterministic
workflow scripts can be written once and driven by any of them. The MVP targets
OpenCode (V2), Claude Code, and Cursor; Codex and Pi are deliberately deferred.
Pre-alpha.

## Read first

- [docs/CODING_STANDARDS.md](docs/CODING_STANDARDS.md) — read before writing or
  reviewing code; every rule there binds every change.
- [docs/DESIGN.md](docs/DESIGN.md) — read before implementing an adapter, changing
  the public interface, or adding a dependency.
- Scope questions resolve against the v1 list in DESIGN.md. If a change would move
  something into or out of scope (events, permissions, auth, model names), stop and
  ask — those boundaries were chosen deliberately.

## Dependencies

Ask before adding any dependency, every time. Each adapter pulls in a heavyweight
SDK package — name the exact package and version in the ask.

## Git

Every change lands via pull request — see [docs/CONTRIBUTING.md](docs/CONTRIBUTING.md)
for branch naming, conventional commits, and PR rules. Direct pushes to `main`
and history rewrites need explicit approval.

## Agent skills

### Issue tracker

Issues live in GitHub Issues on rp-exp/yoke, driven via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Default five-role vocabulary — label strings equal the role names (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: root `CONTEXT.md` + `docs/adr/`. See `docs/agents/domain.md`.

# Coding standards

How yoke code is written. These rules bind every change; the Standards axis of
code review cites this file by rule. Scope questions resolve against
[DESIGN.md](DESIGN.md), not here.

## Types and boundaries

- Strict types everywhere: full type coverage, zero `any`. Adapter boundaries
  are where SDK types tempt you to loosen them — that is exactly where the rule
  binds hardest.
- Parse and validate external data at the boundary before it crosses inward.
  Harness responses, session refs, model refs: decode once at the edge
  (`ref.ts` owns this per adapter); everything inside works on validated types.
- Prefer discriminated unions and literal types (`HarnessId`) so invalid states
  fail to compile. Mark one-off literals `as const`.

## Errors

- Fail fast and loud. Surface every problem; a silent fallback or swallowed
  exception hides it. There are no sanctioned catches that log-and-continue.
- Throw subclasses of `YokeError` (see `src/errors.ts`); pass harness-native
  payloads through `raw`. `TurnResult.raw` and `YokeError.raw` are the only two
  sanctioned escape hatches from strict typing.
- Name the invariant in the message ("turn finished without assistant text"),
  not just the operation.

## Data style

- Immutable data and pure functions; side effects live at the edges (process
  spawning, HTTP) and nowhere else.
- Build objects completely or throw; partial-then-patch shapes are a smell.

## Structure

- Small single-purpose functions and files. One module, one reason to change.
- Each adapter is a trio under `src/adapters/<harness>/`:
  - `ref.ts` — encode/decode of opaque session refs, boundary validation.
  - `client-like.ts` — the minimal `<Harness>Like` interface the adapter needs,
    so tests can fake the SDK without it installed.
  - `backend.ts` — the `<Harness>Backend` implementing `TurnBackend`.
  - `index.ts` — the public surface exported via `package.json`.
- Cross-harness behaviour belongs in `src/conformance/` as cases, so every new
  adapter inherits it; per-adapter scripts in `scripts/` only wire a subject.
- Public API changes go through `src/index.ts` and `package.json` exports;
  nothing else is public.

## Naming

- Files `kebab-case.ts`; types and classes `PascalCase`; error classes end in
  `Error`; SDK-shaped interfaces end in `Like`; backends end in `Backend`.
- Paired encode/decode functions are `encodeRef` / `decodeRef`.
- Names reveal intent: a function whose honest name doesn't come easily is a
  design problem, not a naming problem — fix the shape first.

## Tests

- Test-first: failing test → make it pass → refactor. Every adapter gets unit
  tests against its SDK's types plus one thin integration test; nothing else
  ships untested.
- Unit tests live flat in `tests/<area>.test.ts`, run by `bun test`. Fakes are
  hand-written in-file (`fakeClient`) or shared as `tests/fake-subject.ts`;
  mock libraries stay out.
- Fakes implement the adapter's `<Harness>Like` interface — typed against the
  real SDK types where the SDK is installed, so drift fails typecheck.
- Drive concurrency paths deterministically (hang-until-interrupt wait modes),
  never with timing races.

## Comments

- Comments explain *why* — intent, invariants, non-obvious constraints. The
  code says *what*. When changing code near a comment, update or delete the
  comment in the same change.

## Hygiene

- Keep diffs on-task. Report nearby problems without fixing them.
- Ask before adding any dependency, every time; name the exact package and
  version. Dependencies policy lives in [../AGENTS.md](../AGENTS.md).

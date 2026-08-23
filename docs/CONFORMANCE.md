# Adapter conformance suite

One integration test suite, run against every adapter. It encodes the contracts in
[DESIGN.md](DESIGN.md) — durability tiers, failure contract, concurrency — so
"write once, run against any harness" is verified, not assumed.

Each adapter registers with a declaration:

```ts
interface ConformanceSubject {
  readonly id: HarnessId
  /** Declared durability tier; the suite holds the adapter to exactly this. */
  readonly tier: "A" | "B"
  open(harnessId: HarnessId): Promise<Harness>
}
```

## Running

The suite talks to real harnesses and requires each one logged in under its own
auth story. No silent skips: if a harness is unreachable or unauthenticated, the
suite fails loudly naming the harness and what to fix.

Tier-A cases run only for tier-A declarations; tier B never runs them. The tier
is the contract — an adapter claiming A and failing A is a bug in the adapter.

## Universal cases (every adapter)

Session lifecycle:

1. `createSession({ cwd })` resolves to a handle.
2. `prompt()` with a trivial prompt resolves; `text` is a non-empty string;
   `raw` is present.
3. `serialize()` resolves to a non-empty opaque string.

Failure contract:

4. Second concurrent `prompt()` rejects with `HandleBusyError` (first turn kept
   alive with a long-running instruction).
5. `serialize()` mid-turn rejects with `HandleBusyError`.
6. `abort()` mid-turn makes the pending `prompt()` reject with `TurnAbortedError`.
7. Any `prompt()` after `dispose()` rejects with `HandleDisposedError`.
8. `dispose()` twice does not throw.

Resume (tier A only):

9. Serialize → `createSession({ sessionRef })` → `prompt("What was the last thing
   I asked you?")` — the answer must reference the earlier turn (context carried).
10. The original handle prompts again *after* ownership transferred → rejected
    (`HandleBusyError` when detectable in-process).
11. A garbage ref (valid brand, nonexistent session) rejects loudly — never
    silently starts a fresh session.

Cross-process (tier A only):

12. Ref serialized in process 1 resumes in a spawned child process on the same
    machine; the resumed session carries prior context.

## Best-effort cases (documented, not gating)

- `HarnessUnavailableError` on a bad harness configuration — failure-injection
  mechanics differ too much per harness to normalize the *test*, only the error.
- Post-abort session usability — per-harness by design; each adapter documents it,
  the suite records the observed behavior for the docs table.

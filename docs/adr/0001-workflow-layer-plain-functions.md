---
status: accepted
---

# Workflow layer: plain functions over a DSL

Deterministic multi-agent workflows (implement, code-review, ship) need a layer
above the turn-based core. The layer is vocabulary, not framework: a workflow is
a plain async TypeScript function, and the layer exports six names — `agent` /
`Agent`, `Conversation` (with `run` and `ask`), `RetryPolicy` / `TurnOptions`,
`fakeAgent`, `runWorkflow`. Steps, loops, fan-out, and merging are ordinary
code; if a workflow cannot be written with these plus plain TypeScript, that is
the signal to grow the layer — not a reason to add a framework preemptively.

## The stances

- **Context is a value.** `agent.open()` returns a `Conversation` that owns a
  continuing session. Sharing context = passing the value around; fresh
  context = opening again. Where context flows is visible in call sites and
  signatures; nothing is cached behind the scenes.
- **`ask()` owns the whole reply contract.** The schema (any Standard Schema
  implementation, or a plain function) is stated once, at the call site; the
  layer renders it into the prompt, extracts the JSON, validates, and repairs
  once on the same session with precise issue paths.
- **Fail fast; repeat-safety is declared, not assumed.** The turn timeout is
  always on — this is the workflow-side timer that DESIGN.md's core contract
  ("timeouts are not yoke's job") requires workflows to own. Only reply-shape
  errors auto-retry. Repeating a turn wholesale (`retries: "transient"`, fresh
  session, loud context reset) is an opt-in declared on the agent's spec where
  safety follows from role (read-only reviewers), overridable per turn.
- **A failed turn kills its session, never the conversation.** The next turn
  continues on a fresh session; context resets are logged, never silent.
- **Fakes are values.** `fakeAgent()` returns an `Agent` injected through the
  same seam as everything else and flows through the real turn machinery, so
  fake runs exercise timeouts and the repair loop. No registry, no ambient
  test state in the runtime.

## Considered options

- A step-graph / builder DSL with retry and composition as framework features —
  rejected: the composed prototypes (ship is three function calls) stay smaller
  as plain functions than any DSL invocation would be.
- Schema stated both in the prompt and in validation (a `jsonShape` helper) —
  tried first, rejected: threading the schema twice was the largest authoring
  papercut and easy to get silently wrong.
- A global fake registry keyed by agent id — tried first, rejected: a second
  injection seam, string-coupled to agent definitions.

## Consequences

- The layer stays a prototype (`src/workflow.ts`, examples under
  `examples/prototypes/`, not publicly exported) until validated by porting
  tri-review onto it and by a real-harness run of the code-review workflow.
- Known debts, deliberate until then: `replyContract` imports zod, so only zod
  schemas render their exact JSON shape (other vendors get a generic
  instruction); `runWorkflow` tracks sessions in module state, so two
  concurrent workflows in one process would dispose each other's sessions;
  harness-native schema enforcement (Claude Code `--json-schema`) is unused —
  extraction and validation happen Yoke-side on every harness.

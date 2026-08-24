# Contributing

How changes land in yoke. Code rules live in [CODING_STANDARDS.md](CODING_STANDARDS.md);
scope boundaries live in [DESIGN.md](DESIGN.md).

## Pull-request first

Every change lands via pull request — including your own. Direct pushes to
`main` and history rewrites happen only on explicit ask. Small PRs merge fast;
stack them rather than growing one.

## Branches

Name branches after the change type, kebab-case slug:

```
<type>/<slug>          e.g.  feat/session-ref-validation
                             fix/cursor-ref-decode
```

`<type>` uses the same vocabulary as conventional commits (below), so the
branch name predicts the commit history inside it. One type per branch; if a
change is half feature half fix, split it.

## Commits

Conventional commits, one logical change per commit:

```
<type>(<scope>): <imperative subject>
```

- **Types** — `feat`, `fix`, `docs`, `refactor`, `test`, `chore`, `ci`.
- **Scope** — the area touched: an adapter name (`opencode`, `claude-code`,
  `cursor`), or `conformance`, `types`, `errors`, `docs`.
- **Subject** — imperative, no trailing period: `feat(opencode): validate
  session ids at ref decode`, not `added validation`.

Breaking API changes mark the type with `!` (`feat!:`) and say what breaks in
the body.

## Pull requests

Title uses the same `<type>(<scope>): <subject>` pattern as the commits it
contains. The description states intent — why the change exists, which issue
or spec it implements — and links the originating issue when there is one.

Before opening: tests pass, `tsc --noEmit` clean. Reviewers review against
[CODING_STANDARDS.md](CODING_STANDARDS.md).

# Issue tracker: GitHub

Issues and specs for this repo live as GitHub issues. Use the `gh` CLI for all operations.

## Conventions

- **Create an issue**: `gh issue create --title "..." --body "..."`. Use a heredoc for multi-line bodies.
- **Read an issue**: `gh issue view <number> --comments`, filtering comments by `jq` and also fetching labels.
- **List issues**: `gh issue list --state open --json number,title,body,labels,comments --jq '[.[] | {number, title, body, labels: [.labels[].name], comments: [.comments[].body]}]'` with appropriate `--label` and `--state` filters.
- **Comment on an issue**: `gh issue comment <number> --body "..."`
- **Apply / remove labels**: `gh issue edit <number> --add-label "..."` / `--remove-label "..."`
- **Close**: `gh issue close <number> --comment "..."`

Infer the repo from `git remote -v` — `gh` does this automatically when run inside a clone.

## Project board

Work is tracked on GitHub Project **#4 `yoke`**, owner `rp-exp` ([rp-exp/projects/4](https://github.com/orgs/rp-exp/projects/4)). Every issue has a card on that board. The card's `Status` field holds the position in the flow. **Move the card as soon as the work changes state — not in one batch at the end.**

### IDs

These are stable. Use them directly; do not look them up on every run.

| Thing | ID |
| ----- | -- |
| Project | `PVT_kwDOEkNrqc4BhNYE` |
| `Status` field | `PVTSSF_lADOEkNrqc4BhNYEzhgJ970` |

| Status | Option ID |
| ------ | --------- |
| `Backlog` | `f75ad846` |
| `Shaping` | `df4873e6` |
| `Ready` | `61e4505c` |
| `In progress` | `47fc9ee4` |
| `Waiting for a review` | `677b2df6` |
| `In review` | `df73e18b` |
| `Done` | `98236657` |

If a command reports an unknown field or option, the board changed. Refresh with `gh project field-list 4 --owner rp-exp --format json` and update this file in the same change.

### What each status means

| Status | Meaning |
| ------ | ------- |
| `Backlog` | Nobody has evaluated this yet. Same meaning as the `needs-triage` label — keep them in step. |
| `Shaping` | An agent or human is actively turning the request into a spec (`/to-spec`, `/wayfinder`). |
| `Ready` | The spec is finished; an agent can implement it without further input. Pairs with `spec` + `ready-for-agent`. Never leave work here in `Backlog` or `Shaping`. |
| `In progress` | An implementing agent has claimed the ticket and is working on it (`/ship`, `/implement`). |
| `Waiting for a review` | The PR is open; no review agent has picked it up yet. |
| `In review` | A review agent is reviewing the code now (`/code-review`). |
| `Done` | Merged or closed. Set automatically by the close workflow. |

All work in this flow is done by agents, so `Waiting for a review` means "the PR waits for a review agent", and `In review` means "a review agent works on it now".

### Set the status

```bash
gh project item-edit \
  --id <item-id> \
  --project-id PVT_kwDOEkNrqc4BhNYE \
  --field-id PVTSSF_lADOEkNrqc4BhNYEzhgJ970 \
  --single-select-option-id <option-id>
```

Find `<item-id>` for issue `#<N>`:

```bash
gh project item-list 4 --owner rp-exp --limit 200 --format json \
  | jq -r '.items[] | select(.content.number == <N>) | .id'
```

Built-in project workflows are expected to do two of the steps for you. Do not repeat them:

- **A new issue** gets its card automatically, already set to `Backlog`. Never call `item-add` after `gh issue create`, and never set `Backlog` yourself. If a card is genuinely missing, add it with `gh project item-add 4 --owner rp-exp --url <issue-url>`.
- **A closed issue** goes to `Done` automatically. `gh issue close` is enough.

### Do not touch these fields

`Priority`, `Size`, `Estimate`, `Start date`, and `Target date` are for human planning. Leave them empty unless a human asks for a value.

### Two traps

- **The board is eventually consistent.** A new card takes several seconds to appear — `item-list` gives `[]` until then. This hits both `item-create` and the auto-add workflow, so an `item-edit` immediately after `gh issue create` can fail to find the item. Do the other issue steps first, or retry the lookup. Trust the exit code of `item-edit`; do not read the item back at once to confirm your own write.
- **`item-edit` needs the read-write `project` OAuth scope.** If a project command fails with a missing-scope error, stop and ask the person to run `gh auth refresh --hostname github.com -s project` — the login is interactive, so an agent cannot do it. Do not work around the failure by silently skipping the board.

## Pull requests as a triage surface

**PRs as a request surface: no.** _(Set to `yes` if this repo treats external PRs as feature requests; `/triage` reads this flag.)_

When set to `yes`, PRs run through the same labels and states as issues, using the `gh pr` equivalents:

- **Read a PR**: `gh pr view <number> --comments` and `gh pr diff <number>` for the diff.
- **List external PRs for triage**: `gh pr list --state open --json number,title,body,labels,author,authorAssociation,comments` then keep only `authorAssociation` of `CONTRIBUTOR`, `FIRST_TIME_CONTRIBUTOR`, or `NONE` (drop `OWNER`/`MEMBER`/`COLLABORATOR`).
- **Comment / label / close**: `gh pr comment`, `gh pr edit --add-label`/`--remove-label`, `gh pr close`.

GitHub shares one number space across issues and PRs, so a bare `#42` may be either — resolve with `gh pr view 42` and fall back to `gh issue view 42`.

## When a skill says "publish to the issue tracker"

Create a GitHub issue. A finished spec also gets the `spec` label and the card moves to `Ready` — see `triage-labels.md`. The create workflow leaves the card in `Backlog`; move it. Do not stop in `Shaping` once grilling is done.

## When a skill says "fetch the relevant ticket"

Run `gh issue view <number> --comments`.

## Wayfinding operations

Used by `/wayfinder`. The **map** is a single issue with **child** issues as tickets.

- **Map**: a single issue labelled `wayfinder:map`, holding the Notes / Decisions-so-far / Fog body. `gh issue create --label wayfinder:map`.
- **Child ticket**: an issue linked to the map as a GitHub sub-issue (`gh api` on the sub-issues endpoint). Where sub-issues aren't enabled, add the child to a task list in the map body and put `Part of #<map>` at the top of the child body. Labels: `wayfinder:<type>` (`research`/`prototype`/`grilling`/`task`). Once claimed, the ticket is assigned to the driving dev.
- **Blocking**: GitHub's **native issue dependencies** — the canonical, UI-visible representation. Add an edge with `gh api --method POST repos/<owner>/<repo>/issues/<child>/dependencies/blocked_by -F issue_id=<blocker-db-id>`, where `<blocker-db-id>` is the blocker's numeric **database id** (`gh api repos/<owner>/<repo>/issues/<n> --jq .id`, _not_ the `#number` or `node_id`). GitHub reports `issue_dependencies_summary.blocked_by` (open blockers only — the live gate). Where dependencies aren't available, fall back to a `Blocked by: #<n>, #<n>` line at the top of the child body. A ticket is unblocked when every blocker is closed.
- **Frontier query**: list the map's open children (`gh issue list --state open`, scoped to the map's sub-issues / task list), drop any with an open blocker (`issue_dependencies_summary.blocked_by > 0`, or an open issue in the `Blocked by` line) or an assignee; first in map order wins.
- **Claim**: `gh issue edit <n> --add-assignee @me` — the session's first write.
- **Resolve**: `gh issue comment <n> --body "<answer>"`, then `gh issue close <n>`, then append a context pointer (gist + link) to the map's Decisions-so-far.

# Triage Labels

The skills speak in terms of five canonical triage roles. This file maps those roles to the actual label strings used in this repo's issue tracker.

| Label in mattpocock/skills | Label in our tracker | Meaning                                  |
| -------------------------- | -------------------- | ---------------------------------------- |
| `needs-triage`             | `needs-triage`       | Maintainer needs to evaluate this issue  |
| `needs-info`               | `needs-info`         | Waiting on reporter for more information |
| `ready-for-agent`          | `ready-for-agent`    | Fully specified, ready for an AFK agent  |
| `ready-for-human`          | `ready-for-human`    | Requires human implementation            |
| `wontfix`                  | `wontfix`            | Will not be actioned                     |

When a skill mentions a role (e.g. "apply the AFK-ready triage label"), use the corresponding label string from this table.

Edit the right-hand column to match whatever vocabulary you actually use.

## A finished spec carries `spec` and sits in `Ready`

| Label | Meaning |
| ----- | ------- |
| `spec` | The issue body is a finished spec. Grilling is done. An agent can implement it. |

Apply `spec` when `/to-spec` publishes, in the same step as `ready-for-agent`. Move the card to **`Ready` on project #4 in that same step** — see `issue-tracker.md`. A finished spec must not stay in `Backlog` or `Shaping`. A new issue lands in `Backlog` by itself; that is not done. A request, a bug, or a note that is not a spec does not get this label.

## Labels and the board are both used

A label lives on the issue. The `Status` field lives on the project card. They are separate records, and this repo keeps both — see the "Project board" section of `issue-tracker.md`.

- **Labels classify the ticket**: what kind of work it is, and who must do it.
- **`Status` gives the position in the flow**: `Backlog` → `Shaping` → `Ready` → `In progress` → `Waiting for a review` → `In review` → `Done`.

Two pairs overlap. Keep each pair in step:

- `needs-triage` and `Backlog` both mean "nobody evaluated this yet". When you remove `needs-triage`, move the card out of `Backlog` in the same step.
- `spec` + `ready-for-agent` and `Ready` both mean "grilling is done; implement this". When you apply `spec`, move the card to `Ready` in the same step.

## The labels exist in the repo

All five triage labels exist, together with the `wayfinder:*` set that `issue-tracker.md` uses for maps and child tickets. Apply them directly; do not create them again.

If you add a role that this file does not list, create its label first — `gh label create <name> --color <hex> --description "..."` — and add a row to the table above in the same change.

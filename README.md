# trowel

Personal CLI for orchestrating Change-driven repository work — start, slice, and finish — across any git project.

## Core concepts

- **Change** — the user-visible unit of intended repository work. A Change has one or more Slices, a Target branch, and a Change branch.
- **Slice** — one vertical cut of a Change that can be implemented and reviewed independently.
- **Storage** — where Changes and Slices are tracked: local files or GitHub issues.
- **Slice branch** — the durable branch a Slice Turn runs on. New Slices may store `null`; `prepareImplement` fills it lazily using `work.perSliceBranches`.
- **Turn** — one agent run for one role (`implement`, `audit`, or `review`) against one Slice, or a Change-level Close-out PR revision.
- **Lane** — a local, foreground, human-in-the-loop implementation workspace in a managed worktree, outside the Change/Slice lifecycle.
- **Auditing / Auditor** — the optional branch-diff quality gate after implementation. The Auditor compares the Slice branch against the Change branch, fixes and commits when possible, and records `auditedAt` when ready.
- **Reviewer** — the PR-feedback response role. It runs when an open Slice PR or Close-out PR computes as `needs-revision`, then responds to the feedback and clears that signal when ready.

## Common commands

| Command | Purpose |
| --- | --- |
| `trowel change start [--storage <kind>] [--harness <kind>]` | Understand a user request by grilling, plan repository work, and create a Change when needed. |
| `trowel change create [json] [--storage <kind>]` | Create a Change and Slices from caller-supplied JSON without a Grill or harness. |
| `trowel change list [--storage <kind>]` | List all Changes newest first with computed state. |
| `trowel change status <change-id> [--storage <kind>]` | Show one Change and its Slice states. |
| `trowel change work [change-id] [--loop] [--storage <kind>] [--harness <kind>]` | Run project-wide AFK work across Changes, or scope to one Change when a Change id is provided; `--loop` keeps polling for newly actionable work. |
| `trowel change ship <change-id> [--storage <kind>]` | Ship a finished Change. |
| `trowel change abort <change-id> [--storage <kind>]` | Abort a Change without shipping it. |
| `trowel lane start <title...> [--harness <kind>]` | Start a foreground human-in-the-loop implementation Lane in a managed local worktree. |
| `trowel lane continue <lane-id> [--harness <kind>]` | Open another interactive harness session in an existing Lane worktree. |
| `trowel lane close <lane-id>` | Confirm, squash the Lane branch into its captured Target branch via the git commit editor, remove the Lane worktree, and apply `ship.deleteBranch`. |
| `trowel lane list` | List all Lanes newest first with computed state. |
| `trowel doctor` | Check local tool/config health. |
| `trowel config` | Print resolved config. |
| `trowel init [global\|project]` | Write a config layer. |

`--storage` is offered by commands that read or write Change/Slice state. `--harness` is offered by commands that spawn an agent Turn or interactive Lane session. Run `trowel config` for the effective config plus a generated config reference; `trowel init` also writes `.trowel/schema.json` for editor completion.

Lanes are local interactive workspaces, not Changes or Slices. They are useful when you want multiple terminal tabs running separate foreground agent sessions in isolated worktrees without invoking the full Trowel delivery lifecycle. Lane agents grill the concept first, then batch material implementation-detail decisions for confirmation before chunk planning. Lane implementation proceeds in small reviewable chunks; after each chunk is reviewed and accepted, the agent commits that chunk locally and continues. `trowel lane close` refuses predicted merge conflicts, then squash-closes those per-chunk commits into one Target-branch commit using your normal git commit editor with an editable template.

## Create from an approved specification

Use `change start` for an interactive Grill. Use `change create` when the caller has already prepared the specification:

```sh
trowel change create '{"outcome":"create-change","change":{"title":"Fix auth","body":"Describe the agreed change."},"slices":[{"title":"Fix and test","body":"Implementation and acceptance criteria.","blockedBy":[],"readyForAgent":true}]}' --storage file
# Or pass the same JSON through stdin:
trowel change create --storage file < change.json
```

Supply raw JSON as **one quoted positional argument or stdin**, not a filename argument and not both channels. Missing/empty input is an error. Only `outcome: "create-change"` is accepted; `existing-change` and `no-change` belong to the Grill. The schema is the same creation payload used by `change start`: Change and Slice `title`/`body` strings, Slice `readyForAgent` booleans, and `blockedBy` arrays of zero-based Slice indices. Forward references are allowed; out-of-range/non-integer indices, self-references, and cycles are rejected. Empty `slices` is supported. Validation finishes before any git or storage mutation.

`change create` never prompts, launches a harness, runs Work/Ship, or commits. It does not read, delete, or overwrite `.trowel/start-change-out.json`. There is no `--harness` flag. Every invocation attempts a new Change; content is not deduplicated and failures are not automatically retried.

Creation uses the same post-Grill materialisation and recovery as `change start`: capture the invocation branch as Target, stash dirty files including untracked files, create the storage record and remote Change branch, write branch metadata, fetch/check out the Change branch, restore the stash, then create Slices and resolve blockers/readiness. Both storage kinds need a usable `origin` containing the Target branch; the Change branch starts from its remote tip. Issue storage also needs GitHub access. `--storage file|issue` overrides project configuration for this invocation; keep that selection when running subsequent commands.

On success, the checkout remains on the Change branch with dirty work and file-storage artifacts uncommitted. On failure before branch metadata is saved, recovery restores the invocation branch and stash when possible. After metadata is saved, failures preserve the current branch/stash state for inspection rather than rolling back; this includes fetch/checkout failures and stash conflicts. Errors after a confirmed record creation report its id, intended branch, and confirmed Slice ids. Inspect storage, `git status`, and `git stash list` before doing anything else—rerunning creation is not a resume operation.

The shared existing stash flow has limitations: untracked file-storage records temporarily disappear during allocation and can collide with newly allocated ids, and an unignored `.trowel/lock` can collide on stash restore. Persist prior file-storage records before another creation and ignore the runtime lock; resolve any stash conflict manually. Creation does not add a new transaction or rollback system.

## States and workflow flags

Change states are computed from storage fields, Slice states, branch merge facts, and Close-out PR review surfaces: `open`, `ready`, `awaiting-review`, `needs-revision`, `landed`, `done`, and `aborted`.

Slice states are computed from storage fields and PR review surfaces: `draft`, `open`, `blocked`, `in-flight`, `implemented`, `audited`, `awaiting-review`, `needs-revision`, `landed`, and `done`. `needs-revision` is derived from the PR review surface (for example the configured `labels.needsRevision`, default `needs-revision`, or a changes-requested review decision); it is not stored on the Slice or Change.

Key workflow flags:

- `ship.pr` (default `true`) controls PR-vs-host-merge shipping for Change Close-out, and controls Slice PR integration when a Slice branch differs from the Change branch.
- `work.audit` (default `false`) controls whether the AFK loop runs Auditing after implementation before integrating a Slice or making its Slice PR ready.
- `work.perSliceBranches` (default `true`) controls how `prepareImplement` fills a null Slice branch: when true it creates a per-Slice branch from the latest remote Change branch; when false it stores the parent Change branch and serializes work on that shared branch.
- `work.loopPollSeconds` (default `30`) controls the idle polling interval for `trowel change work <id> --loop` and project-wide `trowel change work --loop`.

Branch behavior: `trowel change start` (when creating) and `trowel change create` intentionally switch the main checkout to the newly created Change branch after materialising the Change. Later host-owned local merges do not use the main checkout: `trowel change work` and merge-based `trowel change ship` merge through reserved trowel change worktrees. Before host-owned local merges, Trowel runs merge conflict preflight; interactive commands ask before proceeding with predicted conflicts, while non-interactive work fails before mutating worktrees or branches. `trowel change ship` and `trowel change abort` also refuse Cleanup when the current branch is one of the local branches Cleanup may delete; switch branches first, then retry.

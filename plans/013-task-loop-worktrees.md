# Plan 013: The task loop — sessions born on worktrees, landed from the diff (Loop 2)

## Status

PROPOSED — drafted 2026-07-03. The biggest build of the Beta three; runs
LAST (after 011/012). Design decisions marked LOCK need the operator before
implementation. Phased: A (attempt creation) ships alone; B (Land) follows.

## The mechanics this is built on (operator explainer, distilled)

A branch is a pointer, not a place: `git checkout` rewrites the working
directory IN PLACE. Under a running agent that is silent corruption — the
agent patches code that no longer exists on disk. Therefore Lume NEVER
switches a session's branch. Instead: `git worktree add <path> -b <branch>
<base>` gives every attempt its own directory with its own branch, all
sharing one object store. **One session = one directory = one branch, for
the session's whole life.** The "branch dropdown" à la Conductor/Codex-app
selects (1) the BASE to fork from at creation and (2) the base to DIFF
against at review — never an in-place switch. Git itself enforces the safety
rail that no branch can be checked out in two worktrees at once (two agents
can never write to one branch).

PRODUCT BOUNDARY: pure git/folder plumbing around the agent. Lume never
launches or instructs agents in the new workspace — the user does (and Plan
009's resume machinery follows them there for free).

## Goal

Close the arc *spawn → work → ping → review → land → gone* without leaving
Lume:

- **Phase A — "New attempt":** from a repo session (sidebar context menu +
  a button beside New Session): pick base branch (dropdown of local +
  remote branches, default = repo default), auto-suggested branch name
  (`lume/<session-name-slug>`), Lume runs `git worktree add`, creates the
  session on that folder, groups it under the repo in the sidebar.
- **Phase B — "Land":** in the Diff tab of a worktree session: one
  affordance that merges the attempt back to its base and cleans up
  (worktree remove + branch delete + session archive), or opens a PR.

## Why this is reliable with what we already have

| Need | Already built |
|---|---|
| Safe git spawning | `run_git` (git.rs): CREATE_NO_WINDOW + thread deadline — Plan 010B |
| Repo/branch awareness | `git_repo_root`, branch poller, Diff tab repo derivation |
| Review surface | Diff tab (@codemirror/merge) — Land is one more header affordance |
| Sessions per folder + grouping | sessionsStore folder sessions, groups, split groups |
| Resume in the new workspace | Plan 009 records per pane, works in any folder |
| Confirm/toast patterns | confirmStore / toastStore |

New Rust commands (all through `run_git`, all read-your-writes verified):
`git_list_branches` (`for-each-ref` local+remote, default via
`symbolic-ref refs/remotes/origin/HEAD` → fallback main/master),
`git_worktree_add`, `git_worktree_remove` (refuses when dirty unless forced),
`git_branch_delete`, `git_merge_ff`/`git_merge` (Phase B), `git_worktree_list`.

## Design (LOCK each with the operator)

- **Worktree location** — LOCK. Proposal: `%USERPROFILE%\lume\worktrees\
  <repoName>\<slug>` — outside the repo (so it never pollutes `git status`
  or the drawer) and outside OneDrive-synced trees (sync churn on thousands
  of files is real; this very repo lives in OneDrive). Setting to override
  the root. Shown (with an open-folder affordance) in the session header.
- **Branch naming** — LOCK. Proposal: `lume/<slug>` prefix so attempt
  branches are recognizable and bulk-cleanable; editable at creation.
- **node_modules honesty** — worktrees don't share installs. v1: after
  creation show a one-time hint chip in the new session ("fresh worktree —
  run your install"), NOTHING auto-runs (boundary: Lume never types).
  A per-repo "setup command" that pre-fills (not executes) can come later.
- **Land strategy** — LOCK. v1 proposal, honest about git's constraints:
  - **PR path (preferred when a remote exists):** `gh pr create` if `gh` is
    on PATH, else open the compare URL in the browser. Zero local-merge
    footguns; CI stays the gate.
  - **Local merge path:** only when the MAIN worktree is on the base branch
    and clean → run `git merge <attempt>` there; otherwise explain what to
    do instead of guessing (a wrong guess here loses work — refusing is the
    feature). Never `--force`, never stash on the user's behalf.
  - After a successful land: confirm → `git worktree remove` (dirty check),
    `git branch -d` (only if merged — `-d` not `-D`), archive the session.
- **Diff base** — Phase B upgrades the Diff tab's HEAD-only base with
  "vs merge-base(<base branch>)" for worktree sessions (the base is KNOWN
  for attempts, removing 010B's ambiguity).
- **Sidebar grammar**: attempt sessions show the branch name (the poller
  already surfaces branches) under the repo's group. No new surfaces.

## Steps

**Phase A**
1. Rust: `git_list_branches`, `git_worktree_add`, `git_worktree_list` +
   fixture-repo tests (temp dirs only; never the Lume repo).
2. "New attempt" UI: creation popover (base dropdown, branch name, location
   preview) → command → `createSession(worktreePath, name)` + group under
   repo + hint chip. Store the attempt metadata { repoRoot, baseBranch,
   branch, worktreePath } in a persisted `attemptStore` (paneResumeStore
   pattern).
3. Guards: name collisions, base fetch-freshness (`git fetch --prune`
   optional toggle, default off — no surprise network), worktree-add
   failures surface as toasts with git's own message.
**Phase B**
4. Rust: `git_worktree_remove`, `git_branch_delete`, merge/ff commands +
   tests incl. dirty/unmerged refusals.
5. Land affordance in the Diff tab header for attempt sessions (PR path /
   local path per Design), cleanup flow with confirms, session archive.
6. Diff-tab merge-base upgrade for attempt sessions.
7. Docs (DESIGN.md task-loop section, README) + CHANGELOG.

## Testing gates

- vitest: attemptStore lifecycle, creation-flow state machine, land-path
  decision matrix (remote/no-remote, gh/no-gh, main-clean/dirty).
- cargo: every new git command against fixture repos (branch listing incl.
  detached/remote-only, worktree add/remove, merged/unmerged delete).
- Manual (operator): full arc on a real repo — new attempt → agent works →
  ping (011) → diff → land → cleanup; plus every refusal path.

## Risks

- Land local-merge edge cases → mitigated by the "refuse and explain"
  stance; PR path is the recommended default.
- Worktree paths on other drives (`subst`, network) → `run_git` timeouts
  already bound the damage; failures toast.
- Long paths on Windows (260 chars) → keep slugs short; document.

## Out of scope

Auto-running install/setup commands (boundary), multi-repo attempts,
conflict-radar across attempts (own future plan), stacked branches.

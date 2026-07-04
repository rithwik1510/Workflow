# Plan 013: The task loop — sessions born on worktrees, landed from the diff (Beta Loop 2)

## Status

APPROVED — design locked with the operator 2026-07-03 (operator delegated
worktree norms to Fable: "decide what's the best choice, norm, and go with
it"; UI bar: "HAS to be good like we have now"):
- **Worktree home**: `%USERPROFILE%\lume\worktrees\<repoFolderName>\<slug>`
  — the user's repo NEVER moves; only attempt copies live here. Outside the
  repo (no git-status/drawer pollution) and outside OneDrive-synced trees
  (sync churn on node_modules-scale file counts). Settings override
  ("Worktree location"). The path is always visible in the attempt UI with
  an open-in-explorer affordance — never hidden from the user.
- **Branch naming**: `lume/<slug>`, slug derived from the attempt name the
  user types (default: the repo folder name + `-attempt-N`). Editable at
  creation; preview shown live.
- **Land strategy**: PR-first when a remote exists (`gh pr create`, else
  open the compare URL); local merge ONLY when provably safe (main worktree
  clean AND on the base branch); otherwise refuse-and-explain. Never force,
  never stash on the user's behalf, `git branch -d` only (never `-D`).
Phased A (attempts) → B (Land). Implement THIRD, after 011/012.

**Phase A: IMPLEMENTED** (attemptStore, worktree Rust commands, New Attempt
popover, fresh-worktree hint chip). **Phase B: IMPLEMENTED** — the Diff-tab
Land… menu (PR / compare-page / provably-safe local merge / cleanup), the
TOCTOU-guarded `git_merge_attempt` (re-checks on-base + clean at merge time,
aborts on conflict), `git_worktree_remove`/`git_branch_delete` (refuse-and-
explain, no --force / -d only), the `gh` probe + `gh pr create`, and the
merge-base diff upgrade (`git_merge_base` + a `base` param on
`git_changed_files`/`git_file_diff`). Manual full-arc verification on a real
repo (below) still pending live-GUI.

## The rule this encodes (operator explainer, distilled)

`git checkout` rewrites files IN PLACE — under a running agent that is
silent corruption. So Lume never switches a session's branch. A worktree
(`git worktree add <path> -b <branch> <base>`) is a second directory with
its own branch, sharing one object store. **One session = one directory =
one branch, for life.** The branch dropdown selects the BASE to fork from
(creation) and to diff against (review) — never an in-place switch. Git
enforces that a branch can't be checked out in two worktrees: two agents
can never write to one branch. Worktrees do NOT share node_modules — Lume
shows a one-time hint; it never runs installs (product boundary: Lume never
types into agents or shells on its own beyond documented resume/autorun).

## Goal

Close the arc without leaving Lume:
**New attempt** (base picker → worktree + branch + session, grouped under
the repo) → agent works (008 signals, 011 pings, 009 resume all apply
unchanged — they're folder-agnostic) → **Diff** (existing tab, upgraded to
merge-base) → **Land** (PR or safe local merge) → **cleanup** (worktree
remove, branch delete, session archived).

## Rust commands (all through `run_git`: CREATE_NO_WINDOW + deadline)

| Command | Impl | Notes |
|---|---|---|
| `git_list_branches(repo)` | `for-each-ref refs/heads refs/remotes --format=%(refname:short)%09%(HEAD)` | Split local/remote; drop `origin/HEAD`; dedupe remote twins of locals |
| `git_default_branch(repo)` | `symbolic-ref --short refs/remotes/origin/HEAD` → fallback: local `main`, then `master`, then current | Preselects the base dropdown |
| `git_worktree_add(repo, path, branch, base)` | `worktree add <path> -b <branch> <base>` | Fails loud (branch exists, path exists, bad base) — error text surfaces in the popover |
| `git_worktree_list(repo)` | `worktree list --porcelain` parsed | Reconcile attemptStore ↔ reality at boot |
| `git_worktree_remove(repo, path)` | `worktree remove <path>` | NO --force in v1; dirty → structured error → UI explains |
| `git_branch_delete(repo, branch)` | `branch -d <branch>` | `-d` only; unmerged → structured error |
| `git_merge_attempt(repo, branch)` | Phase B, guarded (see Land) | Plus `git_repo_state(repo)`: current branch (have), `status --porcelain` clean check |
| `git_has_remote(repo)` / `gh --version` probe | for the Land path decision | gh probe cached per app run |

Every one: fixture-repo cargo tests (temp dirs; NEVER the Lume repo).

## Detailed design

### attemptStore (persisted, paneResumeStore pattern)

`src/store/attemptStore.ts`: `Record<SessionId, Attempt>` where
`Attempt = { repoRoot, repoName, baseBranch, branch, worktreePath,
createdAt, landedAt?: number }`. Written on creation; `landedAt` set by
Land; entry removed when cleanup removes the worktree. Boot reconcile:
worktree gone on disk → drop entry + toast once ("attempt folder missing —
<branch>"). Never blocks boot.

### "New attempt" UI (Phase A) — the quality bar item

- **Entry points**: (1) context menu on any session row / folder group of a
  repo: "New attempt…"; (2) the sidebar's + affordance gains it next to New
  Session. No new top-level surfaces.
- **Popover** (splitMenu/contextMenu micro-store pattern, SettingsModal
  visual language, presence animation, var() fallbacks, reduced-motion):
  - Name field (autofocus, prefilled `attempt-N`, live slug preview).
  - Base dropdown: default branch preselected; locals then remotes,
    type-to-filter; branch glyph. Data from `git_list_branches` fetched on
    open (spinner ≤ one poll; error state inline).
  - Quiet preview line: `lume/<slug> · ~\lume\worktrees\<repo>\<slug>`.
  - [Create attempt] (accent) / [Cancel]. Creation runs: worktree add →
    `createSession(worktreePath, <slug>)` → group under `<repoName>` →
    activate. Failure: popover stays open, git's message shown verbatim
    (git's errors are good; don't paraphrase).
- **Fresh-worktree hint**: one-time slim chip in the new session's pane
  (PaneResumeBanner styling): "Fresh worktree — run your project's install
  before starting an agent · [Open folder] [Dismiss]". Recorded dismissed
  in attemptStore. Lume never runs the install (boundary).
- **Sidebar**: attempt sessions live under the repo's group label; the row
  subtitle area shows the branch (the branch poller already knows it).
  Landed attempts get the archived treatment on cleanup (stopped +
  strikethrough-free — just normal stopped styling; no new grammar).

### Land (Phase B) — in the Diff tab header, attempt sessions only

Button `Land…` → menu of the paths that APPLY (never show a dead option):
1. **Create PR** — remote + gh present: `gh pr create --head <branch>
   --base <base> --fill` in the worktree; success toast links the PR URL
   (opener). gh absent but remote present: "Open compare page" (opener,
   `<remote-url>/compare/<base>...<branch>` for GitHub remotes).
2. **Merge into `<base>` locally** — shown enabled only when
   `git_repo_state` says the MAIN worktree is on `<base>` and clean.
   Otherwise shown disabled with the reason inline ("main checkout is on
   `feat/x` / has uncommitted changes — switch & clean it, or use a PR").
   Refusing with the reason IS the feature; a guessed stash/checkout loses
   user work.
3. After merge (or after the user confirms the PR merged): **Clean up**
   confirm — "Remove worktree and delete `lume/<slug>`?" → worktree remove
   (dirty → explain), branch -d (unmerged → explain), stopSession +
   attemptStore.landedAt. Cleanup is always offered, never automatic.

### Diff-tab base upgrade (Phase B)

For attempt sessions the base is KNOWN: default the Diff tab to
`merge-base(HEAD, <baseBranch>)`… vs HEAD toggle stays. Implemented as a
base parameter on `git_changed_files`/`git_file_diff` (`diff <mergebase>`)
— resolves Plan 010B's documented HEAD-only limitation for exactly the
sessions where it matters.

## Steps

**Phase A**: 1) Rust list/default/add/list commands + tests → 2)
attemptStore + reconcile + tests → 3) popover UI + entry points + creation
flow + hint chip + tests → 4) docs.
**Phase B**: 5) Rust remove/delete/merge/state/remote commands + tests →
6) Land menu + refusal states + cleanup flow + tests → 7) merge-base diff
upgrade + tests → 8) docs + CHANGELOG.

## Testing gates

vitest + typecheck + build; cargo (fixture repos) + clippy + fmt. Manual
(operator, full arc on a real repo): new attempt → install hint → run agent
→ 011 ping → diff (merge-base) → Land via PR AND via local merge → cleanup;
plus refusals: dirty main, unmerged branch delete, duplicate attempt name,
deleted attempt folder at boot.

## Risks

- Windows long paths (>260) → short slugs (cap 30 chars) + home near the
  user root; document.
- `gh` auth state varies → surface gh's own stderr; compare-URL fallback
  always exists for GitHub remotes.
- attemptStore ↔ disk drift (user deletes folders manually) → boot
  reconcile, toast once, never crash.

## Out of scope

Auto-install/setup execution (boundary), per-repo setup-command config,
stacked attempts, conflict radar across attempts (future plan), non-GitHub
PR providers (compare-URL only), moving EXISTING sessions onto worktrees.

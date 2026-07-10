// Thin invoke wrappers for the read-only git commands behind the Diff tab
// (Plan 010 Phase B). Kept in one module so components/stores talk to typed
// functions and tests can mock a single boundary (`@/lib/gitClient`).
//
// Every command runs git on the Rust side with CREATE_NO_WINDOW + a timeout
// (see src-tauri/src/git.rs) — the frontend never spawns a process.

import { invoke } from "@tauri-apps/api/core";

/** Normalised working-tree change vs HEAD. Mirrors the Rust `ChangedFile`. */
export interface ChangedFile {
  /** "modified" | "added" | "deleted" | "renamed" | "untracked" */
  status: ChangedFileStatus;
  /** Repo-relative path (forward slashes). */
  path: string;
  /** Pre-rename path for renamed/copied entries; null otherwise. */
  oldPath: string | null;
}

export type ChangedFileStatus =
  | "modified"
  | "added"
  | "deleted"
  | "renamed"
  | "untracked";

/** Old + new file contents for @codemirror/merge. Mirrors the Rust `FileDiff`. */
export interface FileDiff {
  oldText: string;
  newText: string;
  /** Either side sniffed as binary → render a placeholder, not a diff. */
  binary: boolean;
  /** Either side over the editor size cap → offer "open in editor" instead. */
  tooLarge: boolean;
}

/** Repository root containing `path`, or null when `path` is not in a git repo.
 *  git emits forward slashes here even on Windows, so the result is a stable key
 *  for de-duping repos derived from several pane cwds. */
export function gitRepoRoot(path: string): Promise<string | null> {
  return invoke<string | null>("git_repo_root", { path });
}

/** Changed files for a repo. `base` null → working tree vs HEAD (default). `base`
 *  a commit/ref → `git diff <base>` so an attempt session lists everything it
 *  changed since it forked (merge-base), not just uncommitted work (Plan 013B). */
export function gitChangedFiles(
  repo: string,
  base?: string | null
): Promise<ChangedFile[]> {
  return invoke<ChangedFile[]>("git_changed_files", { repo, base: base ?? null });
}

/** Old/new contents for one changed file. `oldPath` is the pre-rename path for
 *  renamed entries (null otherwise). `base` picks the old side's ref — HEAD by
 *  default, or the merge-base SHA for an attempt session (Plan 013B). */
export function gitFileDiff(
  repo: string,
  path: string,
  oldPath: string | null,
  base?: string | null
): Promise<FileDiff> {
  return invoke<FileDiff>("git_file_diff", { repo, path, oldPath, base: base ?? null });
}

// --- Attempt worktrees (Plan 013 Phase A) -----------------------------------

/** A branch offered as a fork base. Mirrors the Rust `BranchInfo`. */
export interface BranchInfo {
  /** Short name: `main` for a local, `origin/main` for a remote. */
  name: string;
  /** True for the currently checked-out branch. */
  isCurrent: boolean;
  /** True for a remote-tracking branch (rendered under the locals). */
  isRemote: boolean;
}

/** One worktree attached to a repo. Mirrors the Rust `WorktreeEntry`. */
export interface WorktreeEntry {
  path: string;
  /** Short branch name; null for a detached worktree. */
  branch: string | null;
}

// Claude Code's sub-agents auto-create a throwaway `worktree-agent-<hex>` branch
// for every run (see the `.claude/worktrees/*` checkouts). They pile up in the
// repo but are never a branch a human wants to switch to or fork from, so we
// hide them from every branch list. The pattern is deliberately narrow — a hex
// suffix, anchored to a path segment — so real branches that merely live under
// .claude/worktrees (e.g. `feat/*`, `advisor/*`) still appear.
const AGENT_SCRATCH_BRANCH = /(^|\/)worktree-agent-[0-9a-f]+$/i;

/** True for a Claude Code agent-scratch branch, local (`worktree-agent-abc123`)
 *  or remote (`origin/worktree-agent-abc123`). Exported for the switcher tests. */
export function isAgentInternalBranch(name: string): boolean {
  return AGENT_SCRATCH_BRANCH.test(name);
}

/** Local + remote branches to offer as fork bases / switch targets (locals
 *  first). Agent-scratch branches are filtered out. Never rejects — returns []
 *  on any git failure, and the popover shows an error. */
export function gitListBranches(repo: string): Promise<BranchInfo[]> {
  return invoke<BranchInfo[]>("git_list_branches", { repo }).then((branches) =>
    branches.filter((b) => !isAgentInternalBranch(b.name))
  );
}

/** The repo's default branch (origin/HEAD → local main → master → current), or
 *  null. Preselects the base dropdown. */
export function gitDefaultBranch(repo: string): Promise<string | null> {
  return invoke<string | null>("git_default_branch", { repo });
}

/** Fork `base` into a new worktree at `path` on new branch `branch`. Rejects
 *  with an AppError whose `reason` is git's OWN stderr, shown verbatim in the
 *  popover — the one mutating git call in the app. */
export function gitWorktreeAdd(
  repo: string,
  path: string,
  branch: string,
  base: string
): Promise<void> {
  return invoke<void>("git_worktree_add", { repo, path, branch, base });
}

/** Check out an EXISTING local branch into a worktree at `path` (no new
 *  branch). The branch-switcher's path; git itself refuses a branch that is
 *  already checked out in another worktree. Rejects with git's verbatim
 *  stderr, like gitWorktreeAdd. */
export function gitWorktreeAddExisting(
  repo: string,
  path: string,
  branch: string
): Promise<void> {
  return invoke<void>("git_worktree_add_existing", { repo, path, branch });
}

/** Every worktree attached to `repo` (main checkout + attempts). Used at boot
 *  to reconcile attemptStore against reality. Never rejects — [] on failure. */
export function gitWorktreeList(repo: string): Promise<WorktreeEntry[]> {
  return invoke<WorktreeEntry[]>("git_worktree_list", { repo });
}

// --- Land (Plan 013 Phase B) ------------------------------------------------

/** The main checkout's branch + cleanliness. Mirrors the Rust `RepoState`. */
export interface RepoState {
  /** Current branch of the MAIN checkout, or null (detached HEAD / not a repo). */
  currentBranch: string | null;
  /** True when `git status --porcelain` is empty. Drives local-merge enablement. */
  clean: boolean;
}

/** Current branch + clean flag of a repo's main checkout — the basis for the
 *  Land menu's "Merge locally" decision. Never rejects. */
export function gitRepoState(repo: string): Promise<RepoState> {
  return invoke<RepoState>("git_repo_state", { repo });
}

/** The `origin` remote URL, or null when there's no `origin`. Presence decides
 *  whether the Land menu offers a PR / compare-page path. */
export function gitHasRemote(repo: string): Promise<string | null> {
  return invoke<string | null>("git_has_remote", { repo });
}

/** `git merge-base <a> <b>` — the common ancestor commit SHA, or null. Read-only;
 *  used to diff an attempt against where it forked. */
export function gitMergeBase(repo: string, a: string, b: string): Promise<string | null> {
  return invoke<string | null>("git_merge_base", { repo, a, b });
}

/** Merge an attempt's `branch` into `base` in the MAIN checkout. The command
 *  re-verifies the checkout is still on `base` and clean (TOCTOU guard) and
 *  aborts on conflict — rejecting with git's verbatim message on any refusal. */
export function gitMergeAttempt(repo: string, branch: string, base: string): Promise<void> {
  return invoke<void>("git_merge_attempt", { repo, branch, base });
}

/** `git worktree remove <path>` (no --force). Rejects with git's verbatim stderr
 *  when the worktree is dirty — never deletes uncommitted work. */
export function gitWorktreeRemove(repo: string, path: string): Promise<void> {
  return invoke<void>("git_worktree_remove", { repo, path });
}

/** `git branch -d <branch>` (never -D). Rejects with git's verbatim stderr when
 *  the branch isn't merged — the refusal is the safety. */
export function gitBranchDelete(repo: string, branch: string): Promise<void> {
  return invoke<void>("git_branch_delete", { repo, branch });
}

/** Whether the GitHub CLI is on PATH. Cache the result per app run (the caller
 *  does — this still spawns a process each call). */
export function ghAvailable(): Promise<boolean> {
  return invoke<boolean>("gh_available");
}

/** `gh pr create --head <branch> --base <base> --fill` in the worktree. Resolves
 *  to the PR URL gh prints; rejects with gh's verbatim stderr on failure. */
export function ghPrCreate(worktree: string, branch: string, base: string): Promise<string> {
  return invoke<string>("gh_pr_create", { worktree, branch, base });
}

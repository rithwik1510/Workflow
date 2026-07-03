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

/** Working-tree changes vs HEAD for a repo. */
export function gitChangedFiles(repo: string): Promise<ChangedFile[]> {
  return invoke<ChangedFile[]>("git_changed_files", { repo });
}

/** Old/new contents for one changed file. `oldPath` is the pre-rename path for
 *  renamed entries (null for everything else). */
export function gitFileDiff(
  repo: string,
  path: string,
  oldPath: string | null
): Promise<FileDiff> {
  return invoke<FileDiff>("git_file_diff", { repo, path, oldPath });
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

/** Local + remote branches to offer as fork bases (locals first). Never
 *  rejects — returns [] on any git failure, and the popover shows an error. */
export function gitListBranches(repo: string): Promise<BranchInfo[]> {
  return invoke<BranchInfo[]>("git_list_branches", { repo });
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

/** Every worktree attached to `repo` (main checkout + attempts). Used at boot
 *  to reconcile attemptStore against reality. Never rejects — [] on failure. */
export function gitWorktreeList(repo: string): Promise<WorktreeEntry[]> {
  return invoke<WorktreeEntry[]>("git_worktree_list", { repo });
}

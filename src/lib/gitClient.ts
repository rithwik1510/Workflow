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

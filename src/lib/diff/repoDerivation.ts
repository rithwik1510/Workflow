// Repo derivation for the Diff tab (Plan 010 Phase B, locked decision #1).
//
// The diff is per-REPOSITORY, not per-pane: several panes in one session almost
// always share a repo, so per-pane diffs would show N copies of the same thing.
// We therefore collapse a session down to its DISTINCT set of git repos:
//
//   session layout leaves → per-pane cwd (ptyStore) → fallback session.folderPath
//     → git rev-parse --show-toplevel per distinct cwd → dedupe the roots
//
// This module is split into a pure candidate-collector (no IO, fully testable)
// and an async resolver that takes an injectable `resolveRoot` so the whole
// matrix — multi-pane same repo / multi-repo / non-repo — is unit-testable
// without spawning git.

import type { LayoutNode } from "@/store/layout/tree";
import { leaves } from "@/store/layout/tree";

/** Just the session fields we need — keeps callers and tests from constructing a
 *  full Session. */
export interface RepoDerivationSession {
  folderPath: string;
  layoutRoot: LayoutNode | null;
}

/** Per-pane metadata we read — only the cwd matters here. */
export interface PaneCwd {
  cwd: string | null;
}

/**
 * The distinct candidate working directories to resolve, in a stable order.
 * Each pane contributes its cwd, or the session's folderPath when the pane has
 * no tracked cwd (the common case today — cwd tracking is best-effort). A
 * session with no layout falls back to the folderPath alone.
 */
export function sessionRepoCandidates(
  session: RepoDerivationSession,
  panes: Record<string, PaneCwd | undefined>
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (p: string | null | undefined) => {
    if (!p) return;
    if (seen.has(p)) return;
    seen.add(p);
    out.push(p);
  };

  const paneIds = session.layoutRoot ? leaves(session.layoutRoot) : [];
  for (const paneId of paneIds) {
    push(panes[paneId]?.cwd ?? session.folderPath);
  }
  // No panes (session never laid out) → the folder itself is the only candidate.
  if (paneIds.length === 0) push(session.folderPath);
  return out;
}

/**
 * Resolve a session's candidate cwds to the distinct set of git repo roots, in
 * first-seen order. Non-repo cwds (resolveRoot → null) contribute nothing;
 * duplicate roots (several panes in the same repo) collapse to one entry.
 *
 * `resolveRoot` is injected (production: `gitRepoRoot`) so this is testable with
 * a plain map and no git.
 */
export async function deriveRepos(
  session: RepoDerivationSession,
  panes: Record<string, PaneCwd | undefined>,
  resolveRoot: (cwd: string) => Promise<string | null>
): Promise<string[]> {
  const candidates = sessionRepoCandidates(session, panes);
  const roots: string[] = [];
  const seen = new Set<string>();
  for (const cwd of candidates) {
    let root: string | null;
    try {
      root = await resolveRoot(cwd);
    } catch {
      root = null; // a failed rev-parse is "not a repo here", never fatal
    }
    if (root && !seen.has(root)) {
      seen.add(root);
      roots.push(root);
    }
  }
  return roots;
}

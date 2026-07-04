// openBranch — the status-bar branch switcher's action (extends Plan 013).
//
// Selecting a branch NEVER checks out in place: `git checkout` rewrites the
// working directory under whatever agent/shell is running there (the exact
// corruption Plan 013 exists to prevent). Instead, picking a branch takes you
// to a terminal that IS on that branch:
//
//   1. some worktree already has it checked out (git guarantees one branch ≤
//      one worktree) → activate that worktree's session, creating the session
//      first if none exists for that folder;
//   2. a local branch with no worktree → check it out into a fresh worktree
//      under the standard home (`~\lume\worktrees\<repo>\<slug>`) and open a
//      session there;
//   3. a remote-only branch (`origin/x`) → create local `x` tracking it in a
//      fresh worktree (the picker only shows remotes without a local twin).
//
// This is the Conductor/Codex-app feel with Lume's safety model underneath.
// Errors surface as toasts carrying git's verbatim message. Branch-opened
// worktrees are NOT attempts — there is no base branch to land into — so they
// don't enter attemptStore (no Land menu, no install hint).

import { basename, samePath } from "@/lib/sessions/groupingHelpers";
import {
  gitWorktreeAdd,
  gitWorktreeAddExisting,
  gitWorktreeList,
} from "@/lib/gitClient";
import { nextPaneId } from "@/lib/paneIds";
import { buildAttemptPaths, slugify } from "@/sessions/attemptCreate";
import { landErrorText } from "@/sessions/attemptLand";
import { useLayoutStore } from "@/store/layoutStore";
import { useSessionsStore } from "@/store/sessionsStore";
import { useToastStore } from "@/store/toastStore";

export interface OpenBranchTarget {
  /** Short branch name: `main` for a local, `origin/main` for a remote. */
  name: string;
  isRemote: boolean;
}

/** The local branch name a target resolves to: remotes drop the remote segment
 *  (`origin/feature/x` → `feature/x`); locals pass through. */
export function localBranchName(b: OpenBranchTarget): string {
  if (!b.isRemote) return b.name;
  const idx = b.name.indexOf("/");
  return idx === -1 ? b.name : b.name.slice(idx + 1);
}

/** Activate (creating if needed) the session that lives on `folder`. New
 *  sessions are grouped under the repo's name and get their first pane seeded,
 *  mirroring createAttempt. */
function activateSessionOnFolder(folder: string, repoName: string, name?: string): void {
  const s = useSessionsStore.getState();
  const existing = Object.values(s.sessions).find((x) => samePath(x.folderPath, folder));
  if (existing) {
    s.activateSession(existing.id);
    return;
  }
  const id = s.createSession(folder, name ?? basename(folder));
  s.setGroupLabel(folder, repoName);
  s.activateSession(id);
  // A brand-new session has layoutRoot === null; seed its first pane so the
  // pane area isn't blank (initWithFirstPane targets the active session).
  useLayoutStore.getState().initWithFirstPane(nextPaneId());
}

/**
 * Take the user to a terminal on `branch` of `repoRoot` (see module header for
 * the three paths). All git failures — branch already checked out elsewhere in
 * a way we didn't predict, path collisions, network-less remotes — surface as
 * a toast with git's own words; nothing is retried or forced.
 */
export async function openBranch(
  repoRoot: string,
  repoName: string,
  branch: OpenBranchTarget
): Promise<void> {
  const local = localBranchName(branch);
  try {
    const worktrees = await gitWorktreeList(repoRoot);
    const existing = worktrees.find((w) => w.branch === local);
    if (existing) {
      activateSessionOnFolder(existing.path, repoName, local);
      return;
    }
    const { worktreePath } = await buildAttemptPaths(repoName, slugify(local));
    if (branch.isRemote) {
      // Remote-only: create the tracking local in the new worktree.
      await gitWorktreeAdd(repoRoot, worktreePath, local, branch.name);
    } else {
      await gitWorktreeAddExisting(repoRoot, worktreePath, local);
    }
    activateSessionOnFolder(worktreePath, repoName, local);
  } catch (err) {
    useToastStore.getState().push({ severity: "error", message: landErrorText(err) });
  }
}

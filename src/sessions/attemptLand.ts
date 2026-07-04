// attemptLand — the "Land" flows for a finished attempt (Plan 013 Phase B).
//
// Closes the arc a New Attempt opened: turn the work on a `lume/<slug>` branch
// into a merged change (PR-first, else a provably-safe local merge) and clean up
// the worktree. Split, like attemptCreate, into a PURE decision core
// (`decideLandPaths` + the compare-URL helpers — exhaustively unit-tested) and
// async orchestrations that wire git/gh, toasts, confirms, and the stores.
//
// THE DESIGN RULE (operator-locked, plans/013): refuse-and-explain. We NEVER
// force, NEVER stash, NEVER guess. A local merge is offered only when it's
// provably safe (main checkout on the base branch AND clean); otherwise the
// option is shown disabled with the precise reason. Cleanup uses `worktree
// remove` (no --force) and `branch -d` (never -D) — git's own refusals ARE the
// safety, surfaced verbatim.

import { openExternal } from "@/lib/openExternal";
import {
  gitBranchDelete,
  gitMergeAttempt,
  gitWorktreeRemove,
  ghPrCreate,
  type RepoState,
} from "@/lib/gitClient";
import { useAttemptStore, type Attempt } from "@/store/attemptStore";
import { useConfirmStore } from "@/store/confirmStore";
import { useSessionsStore, type SessionId } from "@/store/sessionsStore";
import { useToastStore } from "@/store/toastStore";
import { BRANCH_PREFIX } from "@/sessions/attemptCreate";

// --- Pure decision core -----------------------------------------------------

export interface LandDecisionInput {
  /** An `origin` remote exists (any host). */
  hasRemote: boolean;
  /** That remote is a GitHub remote (github.com) — enables the compare-URL path. */
  isGitHubRemote: boolean;
  /** The `gh` CLI is on PATH. */
  ghAvailable: boolean;
  /** The MAIN checkout's live state (branch + clean). */
  repoState: RepoState;
  /** The branch this attempt forked from — the local merge / PR target. */
  baseBranch: string;
}

/** A menu path's visibility + (for the local merge) enablement and reason.
 *  INAPPLICABLE paths are hidden (`show:false` — never a dead option); the local
 *  merge is always shown but disabled-with-reason when it isn't provably safe. */
export interface LandPaths {
  /** Create a PR via `gh` — shown only with a remote AND gh present. */
  createPr: { show: boolean };
  /** Open the GitHub compare page — shown when a GitHub remote exists but gh
   *  doesn't (the always-available fallback for GitHub remotes). */
  openCompare: { show: boolean };
  /** Merge into the base locally — always shown for an attempt; enabled only when
   *  the main checkout is on the base branch AND clean. */
  localMerge: { show: boolean; enabled: boolean; reason: string | null };
}

/**
 * Decide which Land paths apply, purely from the inputs. The matrix:
 *   - createPr:     hasRemote && ghAvailable
 *   - openCompare:  hasRemote && isGitHubRemote && !ghAvailable
 *   - localMerge:   always shown; enabled iff on base && clean, else the reason
 *     names exactly why (wrong branch / detached / dirty).
 */
export function decideLandPaths(input: LandDecisionInput): LandPaths {
  const { hasRemote, isGitHubRemote, ghAvailable, repoState, baseBranch } = input;

  const createPr = { show: hasRemote && ghAvailable };
  const openCompare = { show: hasRemote && isGitHubRemote && !ghAvailable };

  const { currentBranch, clean } = repoState;
  let reason: string | null = null;
  if (currentBranch === null) {
    reason = `main checkout is on a detached HEAD — check out ${baseBranch} to merge here, or use a PR`;
  } else if (currentBranch !== baseBranch) {
    reason = `main checkout is on ${currentBranch}, not ${baseBranch} — switch to ${baseBranch} to merge here, or use a PR`;
  } else if (!clean) {
    reason = `main checkout has uncommitted changes — commit or stash them, or use a PR`;
  }
  const localMerge = { show: true, enabled: reason === null, reason };

  return { createPr, openCompare, localMerge };
}

// --- GitHub remote helpers (pure) -------------------------------------------

/** A remote URL that points at github.com (https or ssh form). */
export function isGitHubRemote(url: string | null): boolean {
  if (!url) return false;
  return /(^|@|\/\/)github\.com[/:]/i.test(url);
}

/**
 * Build the GitHub compare URL for `<base>...<branch>` from an `origin` URL.
 * Normalises both remote forms to the web origin and strips a trailing `.git`:
 *   - https://github.com/owner/repo.git      → https://github.com/owner/repo
 *   - git@github.com:owner/repo.git          → https://github.com/owner/repo
 * Returns null for a non-GitHub / unparseable remote (the caller then has no
 * compare path). Branch names are URL-encoded per path segment so `lume/x`
 * survives without turning the slash into a new segment being lost.
 */
export function githubCompareUrl(
  remoteUrl: string,
  base: string,
  branch: string
): string | null {
  const m =
    remoteUrl.match(/github\.com[/:]([^/]+)\/(.+?)(?:\.git)?\/?$/i) ?? null;
  if (!m) return null;
  const owner = m[1];
  const repo = m[2];
  const enc = (ref: string) => ref.split("/").map(encodeURIComponent).join("/");
  return `https://github.com/${owner}/${repo}/compare/${enc(base)}...${enc(branch)}`;
}

/** Pull a rejected command's verbatim message (AppError carries `reason`),
 *  falling back to a plain stringify. Shared with the popover's error surfacing. */
export function landErrorText(err: unknown): string {
  if (
    err &&
    typeof err === "object" &&
    "reason" in err &&
    typeof (err as { reason?: unknown }).reason === "string"
  ) {
    return (err as { reason: string }).reason;
  }
  return err instanceof Error ? err.message : String(err);
}

/** The attempt's slug (branch minus the `lume/` prefix) — for user-facing copy. */
function attemptSlug(attempt: Attempt): string {
  return attempt.branch.startsWith(BRANCH_PREFIX)
    ? attempt.branch.slice(BRANCH_PREFIX.length)
    : attempt.branch;
}

// --- Async orchestrations ---------------------------------------------------

/**
 * Create a PR for the attempt via `gh pr create` (run in the worktree). On
 * success: a success toast whose message is the PR URL, plus a clickable
 * "open" — and the standalone Clean up option remains in the menu (we do NOT
 * auto-clean after a PR: the branch must survive until the PR merges, and
 * `branch -d` would rightly refuse an unmerged branch). On failure: gh's own
 * words, verbatim.
 */
export async function createPrForAttempt(attempt: Attempt): Promise<void> {
  try {
    const url = await ghPrCreate(attempt.worktreePath, attempt.branch, attempt.baseBranch);
    const toast = useToastStore.getState();
    toast.push({ severity: "success", message: `Pull request created — ${url}` });
    // Best-effort open in the real browser (only if it looks like a URL).
    if (/^https?:\/\//i.test(url)) void openExternal(url);
  } catch (err) {
    useToastStore.getState().push({ severity: "error", message: landErrorText(err) });
  }
}

/** Open the GitHub compare page in the user's browser (the gh-absent fallback). */
export async function openCompareForAttempt(
  attempt: Attempt,
  remoteUrl: string
): Promise<void> {
  const url = githubCompareUrl(remoteUrl, attempt.baseBranch, attempt.branch);
  if (!url) {
    useToastStore
      .getState()
      .push({ severity: "warn", message: "Couldn’t build a compare URL for this remote." });
    return;
  }
  await openExternal(url);
}

/**
 * Merge the attempt into its base locally. The Rust command re-verifies safety
 * (on base + clean) and aborts any conflict, so a rejection here is always a
 * clean refusal carrying git's verbatim reason. On success: a toast, then the
 * Clean up offer (the confirm IS the offer — cleanup is never automatic).
 */
export async function mergeAttemptLocally(
  sessionId: SessionId,
  attempt: Attempt
): Promise<void> {
  try {
    await gitMergeAttempt(attempt.repoRoot, attempt.branch, attempt.baseBranch);
  } catch (err) {
    useToastStore.getState().push({ severity: "error", message: landErrorText(err) });
    return;
  }
  useToastStore
    .getState()
    .push({ severity: "success", message: `Merged ${attempt.branch} into ${attempt.baseBranch}` });
  // Offer cleanup right after a successful local land (its confirm is the offer).
  await cleanupAttempt(sessionId, attempt);
}

/**
 * Clean up a landed attempt: confirm → `worktree remove` → `branch -d` →
 * stopSession → mark landed. The chain STOPS at the first failure with the
 * tool's verbatim error (no partial silent cleanup): a dirty worktree or an
 * unmerged branch refuses, and the user sees exactly why. Ordered
 * worktree-before-branch because git won't delete a branch checked out in a
 * worktree.
 */
export async function cleanupAttempt(
  sessionId: SessionId,
  attempt: Attempt
): Promise<void> {
  const slug = attemptSlug(attempt);
  const ok = await useConfirmStore.getState().confirm({
    title: "Clean up attempt",
    message: `Remove the worktree and delete ${attempt.branch}? This can’t be undone.`,
    confirmLabel: "Remove",
    cancelLabel: "Keep",
    danger: true,
  });
  if (!ok) return;

  const toast = useToastStore.getState();
  try {
    await gitWorktreeRemove(attempt.repoRoot, attempt.worktreePath);
  } catch (err) {
    toast.push({ severity: "error", message: landErrorText(err) });
    return;
  }
  try {
    await gitBranchDelete(attempt.repoRoot, attempt.branch);
  } catch (err) {
    // Worktree is gone but the branch refused (unmerged) — surface it and stop.
    toast.push({ severity: "error", message: landErrorText(err) });
    return;
  }
  useSessionsStore.getState().stopSession(sessionId);
  useAttemptStore.getState().markLanded(sessionId);
  toast.push({ severity: "success", message: `Cleaned up ${slug}` });
}

// attemptCreate — the "New attempt" creation flow (Plan 013 Phase A).
//
// Splits into PURE naming/path helpers (exhaustively unit-tested — slug matrix,
// collision uniquify, path building) and one async orchestration that ties git,
// the sessions store, and the attempt store together.
//
// Locked norms (operator-approved, see plans/013):
//   - worktree home: %USERPROFILE%\lume\worktrees\<repoFolderName>\<slug>
//     (the repo itself NEVER moves; only attempt copies live here)
//   - branch: lume/<slug>
//   - slug: lowercase [a-z0-9-], dash-collapsed, trimmed, max 30 chars,
//     uniquified with -2/-3 on collision
//
// Lume forks the folder and steps back: it creates the worktree + session, then
// shows a one-time hint to run the install. It NEVER runs the install itself.

import { homeDir } from "@/lib/fsClient";
import { gitWorktreeAdd } from "@/lib/gitClient";
import { nextPaneId } from "@/lib/paneIds";
import { samePath } from "@/lib/sessions/groupingHelpers";
import { useAttemptStore } from "@/store/attemptStore";
import { useLayoutStore } from "@/store/layoutStore";
import { useSessionsStore, type SessionId } from "@/store/sessionsStore";

/** Windows long-path defence (see plans/013 Risks): a short slug keeps the full
 *  worktree path well under the 260-char limit even for deep repo names. */
export const MAX_SLUG_LEN = 30;
/** Every attempt branch is namespaced so it's unmistakable in `git branch`. */
export const BRANCH_PREFIX = "lume/";

// --- Pure helpers -----------------------------------------------------------

/**
 * Normalise an attempt name into a branch/dir-safe slug: lowercase, every run
 * of non-`[a-z0-9]` collapsed to a single dash, leading/trailing dashes
 * trimmed, capped at MAX_SLUG_LEN (re-trimming any dash the cut left dangling).
 * An input that slugs to nothing (all punctuation / non-latin) falls back to
 * "attempt" so we never build a `lume/` branch or an empty folder name.
 */
export function slugify(input: string): string {
  const slug = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "")
    .slice(0, MAX_SLUG_LEN)
    .replace(/-+$/, "");
  return slug || "attempt";
}

/**
 * Return `base` if free, else `base-2`, `base-3`, … skipping any already taken.
 * The numeric suffix is kept within MAX_SLUG_LEN by trimming the base to leave
 * room (and re-trimming a dash the cut leaves behind), so a 30-char slug still
 * uniquifies cleanly instead of overflowing the cap.
 */
export function uniquifySlug(base: string, taken: Iterable<string>): string {
  const set = new Set(taken);
  if (!set.has(base)) return base;
  for (let i = 2; ; i++) {
    const suffix = `-${i}`;
    const trimmed = base.slice(0, MAX_SLUG_LEN - suffix.length).replace(/-+$/, "");
    const candidate = `${trimmed}${suffix}`;
    if (!set.has(candidate)) return candidate;
  }
}

/**
 * The prefilled attempt NAME (a display string, not yet a slug): the repo name
 * plus the lowest free `-attempt-N`. Collision is checked against the SLUGS
 * already taken, so the suggestion is one the user can accept as-is.
 */
export function suggestAttemptName(repoName: string, takenSlugs: Iterable<string>): string {
  const set = new Set(takenSlugs);
  for (let n = 1; ; n++) {
    const name = `${repoName}-attempt-${n}`;
    if (!set.has(slugify(name))) return name;
  }
}

export interface AttemptPaths {
  /** Per-repo home: <home>\lume\worktrees\<repoName>. */
  worktreeHome: string;
  /** This attempt's folder: <worktreeHome>\<slug>. */
  worktreePath: string;
}

/** Build the worktree paths from an already-resolved home dir. Pure so the path
 *  shape is unit-tested without a Tauri runtime. Windows separators (Lume is
 *  Windows-only — see CONTEXT.md). */
export function attemptPaths(home: string, repoName: string, slug: string): AttemptPaths {
  const base = home.replace(/[\\/]+$/, "");
  const worktreeHome = `${base}\\lume\\worktrees\\${repoName}`;
  return { worktreeHome, worktreePath: `${worktreeHome}\\${slug}` };
}

/** Replace the home-dir prefix of `path` with `~` for the popover's quiet
 *  preview line. Case-insensitive (Windows). Leaves non-home paths untouched. */
export function shortenHomePath(path: string, home: string): string {
  const h = home.replace(/[\\/]+$/, "");
  if (h && path.toLowerCase().startsWith(h.toLowerCase())) {
    return `~${path.slice(h.length)}`;
  }
  return path;
}

// --- Async orchestration ----------------------------------------------------

// TODO(013B integration): a Settings "Worktree location" override will replace
// this hardcoded default home; buildAttemptPaths is the single seam to swap.
/** Resolve the real home dir and build the attempt's worktree paths. */
export async function buildAttemptPaths(repoName: string, slug: string): Promise<AttemptPaths> {
  const home = await homeDir();
  return attemptPaths(home, repoName, slug);
}

export interface CreateAttemptParams {
  /** The repo (main checkout root) to fork. */
  repoRoot: string;
  /** Repo folder basename — the sidebar group label + worktree-home segment. */
  repoName: string;
  /** The base branch to fork from (the picker's selection). */
  baseBranch: string;
  /** The name the user typed (default suggestAttemptName); slugified here. */
  attemptName: string;
}

/**
 * Create an attempt end to end:
 *   1. derive a unique slug (against this repo's existing attempts)
 *   2. `git worktree add <path> -b lume/<slug> <base>` (may reject with git's
 *      verbatim stderr — the caller keeps the popover open and shows it)
 *   3. create a session ON the worktree, grouped under the repo name
 *   4. activate it + seed its first pane (mirrors createAndActivateSession)
 *   5. record the attempt (drives the sidebar branch subtitle + the hint chip)
 *
 * Returns the new session id. Only step 2 can fail; everything after it only
 * runs once git has actually produced the worktree.
 */
export async function createAttempt(p: CreateAttemptParams): Promise<SessionId> {
  const takenSlugs = Object.values(useAttemptStore.getState().attempts)
    .filter((a) => samePath(a.repoRoot, p.repoRoot))
    .map((a) => a.branch.slice(BRANCH_PREFIX.length));
  const slug = uniquifySlug(slugify(p.attemptName), takenSlugs);
  const branch = `${BRANCH_PREFIX}${slug}`;

  const { worktreePath } = await buildAttemptPaths(p.repoName, slug);

  // The one mutating git call. Rejects with git's own message (branch exists,
  // path exists, bad base) — surfaced verbatim by the popover.
  await gitWorktreeAdd(p.repoRoot, worktreePath, branch, p.baseBranch);

  const sessions = useSessionsStore.getState();
  const sessionId = sessions.createSession(worktreePath, slug);
  // Group the attempt under the repo's name (reuse group labels — no new
  // sidebar grammar). Each worktree is its own folder-group; the label makes it
  // read as belonging to the repo it forked.
  sessions.setGroupLabel(worktreePath, p.repoName);
  sessions.activateSession(sessionId);
  // A brand-new session has layoutRoot === null; seed its first pane now so the
  // pane area isn't blank (initWithFirstPane targets the active session).
  useLayoutStore.getState().initWithFirstPane(nextPaneId());

  useAttemptStore.getState().addAttempt(sessionId, {
    repoRoot: p.repoRoot,
    repoName: p.repoName,
    baseBranch: p.baseBranch,
    branch,
    worktreePath,
    createdAt: Date.now(),
    hintDismissed: false,
  });

  return sessionId;
}

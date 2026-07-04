// attemptStore — durable record of the "attempts" a user has forked (Plan 013
// Phase A). An attempt is a git worktree: a session born in an isolated folder
// on its own `lume/<slug>` branch, forked from a base branch of a repo. The
// repo itself NEVER moves — only these attempt copies live under the worktree
// home. This store remembers, per session, everything the sidebar / diff / land
// flows need: which repo it forked, the base it forked from, its branch and
// worktree path, and whether the one-time "fresh worktree" install hint has
// been dismissed.
//
// Keyed by SessionId (crypto.randomUUID, STABLE across restarts) — unlike the
// paneResumeStore, which is keyed by paneId and needs the launch-time remap.
// Session ids don't churn, so nothing here re-keys on rehydrate.
//
// PRODUCT BOUNDARY: this only records where an attempt lives and how it was
// forked. It never stores prompts, transcripts, or anything about what the
// agent inside is doing. Lume forks the folder and gets out of the way — it
// never runs the install (the hint just reminds the user to).

import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import { immer } from "zustand/middleware/immer";

import { tauriPersistStorage } from "@/lib/persistStorage";
import { gitWorktreeList } from "@/lib/gitClient";
import { useToastStore } from "@/store/toastStore";
import type { SessionId } from "@/store/sessionsStore";

export interface Attempt {
  /** The repo this attempt forked FROM (its main checkout root). */
  repoRoot: string;
  /** Display name of the repo (its folder basename) — the sidebar group label. */
  repoName: string;
  /** The branch this attempt was forked from (the base picker's choice). */
  baseBranch: string;
  /** This attempt's own branch: `lume/<slug>`. */
  branch: string;
  /** The isolated worktree directory the session runs in. */
  worktreePath: string;
  createdAt: number;
  /** The one-time "fresh worktree — run your install" chip: true once dismissed. */
  hintDismissed: boolean;
  /** Set by Land's cleanup once the attempt has been merged/PR'd and its worktree
   *  removed — the record then reads as "landed" (a stopped, archived attempt)
   *  for the rest of the session, and boot reconcile drops it (worktree gone). */
  landedAt?: number;
}

interface AttemptState {
  attempts: Record<SessionId, Attempt>;
}

interface AttemptActions {
  /** Record a freshly-created attempt against its session. */
  addAttempt: (sessionId: SessionId, attempt: Attempt) => void;
  /** Persist the one-time hint dismissal for this attempt's pane chip. */
  dismissHint: (sessionId: SessionId) => void;
  /** Stamp the attempt as landed (cleanup succeeded) — keeps the record for the
   *  session's lifetime with a "landed" marker. No-op on an unknown session. */
  markLanded: (sessionId: SessionId) => void;
  /** Drop an attempt record (boot reconcile when its folder is gone; cleanup). */
  removeAttempt: (sessionId: SessionId) => void;
  reset: () => void;
}

export type AttemptStore = AttemptState & AttemptActions;

export const useAttemptStore = create<AttemptStore>()(
  persist(
    immer((set) => ({
      attempts: {},

      addAttempt: (sessionId, attempt) =>
        set((s) => {
          s.attempts[sessionId] = attempt;
        }),

      dismissHint: (sessionId) =>
        set((s) => {
          const a = s.attempts[sessionId];
          if (a) a.hintDismissed = true;
        }),

      markLanded: (sessionId) =>
        set((s) => {
          const a = s.attempts[sessionId];
          if (a) a.landedAt = Date.now();
        }),

      removeAttempt: (sessionId) =>
        set((s) => {
          delete s.attempts[sessionId];
        }),

      reset: () =>
        set((s) => {
          s.attempts = {};
        }),
    })),
    {
      name: "attempts",
      storage: createJSONStorage(() => tauriPersistStorage("lume-attempts.json")),
      version: 1,
      partialize: (state) => ({ attempts: state.attempts }),
    }
  )
);

// ---------------------------------------------------------------------------
// Boot reconcile (attemptStore ↔ disk). A user can `git worktree remove` or
// delete an attempt folder outside Lume; a stale record would then point at a
// folder that no longer exists. On launch we ask git for the real worktree list
// per distinct repo and drop any record whose worktree path git no longer knows
// about, with a single warn toast. This MUST NEVER block or crash boot —
// every failure (git missing, repo gone, timeout) degrades silently to keeping
// the record (better a stale entry than a lost boot).
// ---------------------------------------------------------------------------

/** Normalise a path for comparison: forward slashes, no trailing slash, lower
 *  case (Windows app — see groupingHelpers.samePath). git emits forward-slash
 *  worktree paths, our stored paths use backslashes, so we must fold both. */
function normalizePath(p: string): string {
  return p.replace(/[/\\]+/g, "/").replace(/\/+$/, "").toLowerCase();
}

export async function reconcileAttempts(): Promise<void> {
  const store = useAttemptStore.getState();
  const records = store.attempts;
  const sessionIds = Object.keys(records);
  if (sessionIds.length === 0) return;

  // Group session ids by the repo they forked from, so we hit git once per repo.
  const byRepo = new Map<string, SessionId[]>();
  for (const sid of sessionIds) {
    const repo = records[sid].repoRoot;
    (byRepo.get(repo) ?? byRepo.set(repo, []).get(repo)!).push(sid);
  }

  for (const [repoRoot, ids] of byRepo) {
    let live: Set<string>;
    try {
      const entries = await gitWorktreeList(repoRoot);
      live = new Set(entries.map((e) => normalizePath(e.path)));
    } catch {
      // git failed for this repo — leave every record intact and move on.
      continue;
    }
    // A successful-but-empty list means git couldn't see this repo at all
    // (not a repo anymore) — don't nuke the records on that ambiguous signal.
    if (live.size === 0) continue;

    for (const sid of ids) {
      const rec = useAttemptStore.getState().attempts[sid];
      if (!rec) continue;
      if (!live.has(normalizePath(rec.worktreePath))) {
        useAttemptStore.getState().removeAttempt(sid);
        useToastStore.getState().push({
          severity: "warn",
          message: `Attempt folder missing — ${rec.branch}`,
        });
      }
    }
  }
}

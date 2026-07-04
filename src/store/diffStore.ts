// src/store/diffStore.ts
//
// State for the Diff tab (Plan 010 Phase B) — a read-only, git-powered review
// surface. Mirrors the Editor Full View pattern (mdStore): `open` swaps the
// central area for <DiffView/>, arbitrated in App.tsx exactly like mdEditorMode.
//
// What lives here: the resolved repo set for the active session, which repo is
// showing, its changed-file list, the selected file, and the unified/split view
// preference. The heavy lifting (spawning git) is on the Rust side via
// gitClient; repo derivation is the pure helper in lib/diff/repoDerivation.
//
// Freshness: openDiff derives repos + lists files once. The existing single-
// flight branch poller (Plan 006) calls refresh({ quiet: true }) each cycle
// WHILE THE SURFACE IS OPEN — no second polling system, and polling is skipped
// entirely when closed (the poller guards on `open`). A manual refresh button
// calls refresh() (non-quiet: shows the spinner + re-selects a file).
//
// Only `viewMode` persists (a UI preference); repos/files/selection are ephemeral
// session state, re-derived on each open — matching mdStore's partialize.

import { create } from "zustand";
import { devtools, persist, createJSONStorage } from "zustand/middleware";
import { immer } from "zustand/middleware/immer";

import { gitRepoRoot, gitChangedFiles, gitMergeBase, type ChangedFile } from "@/lib/gitClient";
import { deriveRepos } from "@/lib/diff/repoDerivation";
import { tauriPersistStorage } from "@/lib/persistStorage";
import { useAttemptStore } from "@/store/attemptStore";
import { useSessionsStore } from "@/store/sessionsStore";
import { usePtyStore } from "@/store/ptyStore";
import { samePath } from "@/lib/sessions/groupingHelpers";

export type DiffViewMode = "unified" | "split";
/** For an attempt session, the diff can be taken against HEAD (working tree) or
 *  the merge-base with the branch it forked from (everything the attempt did). */
export type DiffBaseMode = "head" | "mergeBase";

export interface DiffStoreState {
  open: boolean;
  /** Distinct git repos derived from the active session's panes, in order. */
  repos: string[];
  activeRepo: string | null;
  files: ChangedFile[];
  /** Repo-relative path of the file whose diff is shown, or null. */
  selectedPath: string | null;
  viewMode: DiffViewMode;
  /** True while a non-quiet list is loading (openDiff / manual refresh). */
  loading: boolean;
  /** Set when repo listing failed — DiffView shows it as an empty-state line. */
  error: string | null;

  // --- Merge-base diff (Plan 013 Phase B), attempt sessions only ---
  /** The base BRANCH an attempt session forked from (toggle label); null for a
   *  non-attempt session (which is always HEAD-only). */
  baseBranch: string | null;
  /** The repo the merge-base applies to (the attempt's worktree root). Only when
   *  the ACTIVE repo equals this does the toggle show / merge-base apply. */
  attemptRepo: string | null;
  /** Resolved merge-base(HEAD, baseBranch) SHA, or null (not an attempt / no
   *  common ancestor). */
  mergeBase: string | null;
  /** Which base the diff currently uses. Defaults to "mergeBase" for an attempt
   *  session (when a merge-base resolved), else "head". Not persisted. */
  baseMode: DiffBaseMode;
  /** The actual ref to diff the old side against — the merge-base SHA when in
   *  merge-base mode for the attempt's repo, else null (= HEAD). Kept in state so
   *  DiffView passes the SAME base to gitFileDiff that the list was built with. */
  activeBase: string | null;

  openDiff: () => Promise<void>;
  closeDiff: () => void;
  setActiveRepo: (repo: string) => Promise<void>;
  selectFile: (path: string | null) => void;
  setViewMode: (mode: DiffViewMode) => void;
  /** Flip HEAD ⇄ merge-base and re-list (attempt sessions only). */
  setBaseMode: (mode: DiffBaseMode) => Promise<void>;
  /** Re-list the active repo. `quiet` (poller) keeps the current selection and
   *  never toggles the spinner; non-quiet (open / manual) re-selects the first
   *  file when nothing is selected. */
  refresh: (opts?: { quiet?: boolean }) => Promise<void>;
  reset: () => void;
}

// Stale-response guard. openDiff/setActiveRepo/closeDiff bump this; an in-flight
// derive or list whose token is stale drops its result (the user moved on).
let _req = 0;

/** The ref to diff the old side against, given the current state: the merge-base
 *  SHA only when we're in merge-base mode AND the active repo is the attempt's
 *  repo (a multi-repo attempt session's OTHER repos stay HEAD-only); else null
 *  (= HEAD). Pure so openDiff/setActiveRepo/setBaseMode all resolve identically. */
function resolveActiveBase(s: {
  baseMode: DiffBaseMode;
  mergeBase: string | null;
  activeRepo: string | null;
  attemptRepo: string | null;
}): string | null {
  if (s.baseMode !== "mergeBase" || !s.mergeBase || !s.activeRepo || !s.attemptRepo) {
    return null;
  }
  return samePath(s.activeRepo, s.attemptRepo) ? s.mergeBase : null;
}

export const useDiffStore = create<DiffStoreState>()(
  devtools(
    persist(
      immer((set, get) => ({
        open: false,
        repos: [],
        activeRepo: null,
        files: [],
        selectedPath: null,
        viewMode: "unified",
        loading: false,
        error: null,
        baseBranch: null,
        attemptRepo: null,
        mergeBase: null,
        baseMode: "head",
        activeBase: null,

        openDiff: async () => {
          const req = ++_req;
          set((s) => {
            s.open = true;
            s.loading = true;
            s.error = null;
          });
          const sessions = useSessionsStore.getState();
          const activeId = sessions.activeSessionId;
          const session = activeId ? sessions.sessions[activeId] : null;
          if (!session) {
            if (req !== _req) return;
            set((s) => {
              s.repos = [];
              s.activeRepo = null;
              s.files = [];
              s.selectedPath = null;
              s.loading = false;
              s.baseBranch = null;
              s.attemptRepo = null;
              s.mergeBase = null;
              s.baseMode = "head";
              s.activeBase = null;
            });
            return;
          }
          const panes = usePtyStore.getState().panes;
          const repos = await deriveRepos(session, panes, gitRepoRoot);
          if (req !== _req) return; // closed / re-opened while resolving
          const activeRepo = repos[0] ?? null;

          // Attempt session? Resolve merge-base(HEAD, baseBranch) up front so the
          // FIRST list is already merge-base-relative (no HEAD flash). Falls back
          // to HEAD when there's no attempt or no common ancestor.
          const attempt = activeId ? useAttemptStore.getState().attempts[activeId] : undefined;
          let mergeBase: string | null = null;
          if (attempt && activeRepo) {
            mergeBase = await gitMergeBase(activeRepo, "HEAD", attempt.baseBranch).catch(
              () => null
            );
            if (req !== _req) return;
          }
          set((s) => {
            s.repos = repos;
            s.activeRepo = activeRepo;
            s.files = [];
            s.selectedPath = null;
            s.baseBranch = attempt ? attempt.baseBranch : null;
            s.attemptRepo = attempt && activeRepo ? activeRepo : null;
            s.mergeBase = mergeBase;
            s.baseMode = mergeBase ? "mergeBase" : "head";
            s.activeBase = resolveActiveBase(s);
          });
          if (get().activeRepo) {
            await get().refresh({ quiet: false });
          } else {
            set((s) => {
              s.loading = false;
            });
          }
        },

        closeDiff: () => {
          _req++; // invalidate any in-flight derive/list
          set((s) => {
            s.open = false;
            s.loading = false;
          });
        },

        setActiveRepo: async (repo) => {
          _req++;
          set((s) => {
            s.activeRepo = repo;
            s.files = [];
            s.selectedPath = null;
            // Merge-base only applies to the attempt's own repo; switching to
            // another repo in a multi-repo session falls back to HEAD.
            s.activeBase = resolveActiveBase(s);
          });
          await get().refresh({ quiet: false });
        },

        selectFile: (path) =>
          set((s) => {
            s.selectedPath = path;
          }),

        setViewMode: (mode) =>
          set((s) => {
            s.viewMode = mode;
          }),

        setBaseMode: async (mode) => {
          set((s) => {
            s.baseMode = mode;
            s.activeBase = resolveActiveBase(s);
          });
          await get().refresh({ quiet: false });
        },

        refresh: async ({ quiet = false } = {}) => {
          const repo = get().activeRepo;
          if (!repo) {
            set((s) => {
              s.files = [];
              s.loading = false;
            });
            return;
          }
          const req = _req; // don't bump — refresh runs under the current token
          if (!quiet) {
            set((s) => {
              s.loading = true;
              s.error = null;
            });
          }
          try {
            const files = await gitChangedFiles(repo, get().activeBase);
            if (req !== _req || get().activeRepo !== repo) return; // superseded
            set((s) => {
              s.files = files;
              // Drop a selection whose file is no longer changed.
              if (s.selectedPath && !files.some((f) => f.path === s.selectedPath)) {
                s.selectedPath = null;
              }
              // On an explicit open/refresh, land on the first file so the pane
              // isn't blank. Quiet poller refreshes never yank the selection.
              if (!quiet && s.selectedPath === null && files.length > 0) {
                s.selectedPath = files[0]!.path;
              }
              s.loading = false;
              s.error = null;
            });
          } catch (err) {
            if (req !== _req) return;
            set((s) => {
              s.error = err instanceof Error ? err.message : String(err);
              s.files = [];
              s.loading = false;
            });
          }
        },

        reset: () => {
          _req++;
          set((s) => {
            s.open = false;
            s.repos = [];
            s.activeRepo = null;
            s.files = [];
            s.selectedPath = null;
            s.loading = false;
            s.error = null;
            s.baseBranch = null;
            s.attemptRepo = null;
            s.mergeBase = null;
            s.baseMode = "head";
            s.activeBase = null;
          });
        },
      })),
      {
        name: "diff",
        storage: createJSONStorage(() => tauriPersistStorage("lume-store.json")),
        version: 1,
        // Only the view preference survives restart; the diff itself is derived
        // fresh every open (DESIGN.md §4 EXCLUDED ephemeral state).
        partialize: (state) => ({ viewMode: state.viewMode }),
      }
    ),
    { name: "diffStore" }
  )
);

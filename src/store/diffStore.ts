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

import { gitRepoRoot, gitChangedFiles, type ChangedFile } from "@/lib/gitClient";
import { deriveRepos } from "@/lib/diff/repoDerivation";
import { tauriPersistStorage } from "@/lib/persistStorage";
import { useSessionsStore } from "@/store/sessionsStore";
import { usePtyStore } from "@/store/ptyStore";

export type DiffViewMode = "unified" | "split";

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

  openDiff: () => Promise<void>;
  closeDiff: () => void;
  setActiveRepo: (repo: string) => Promise<void>;
  selectFile: (path: string | null) => void;
  setViewMode: (mode: DiffViewMode) => void;
  /** Re-list the active repo. `quiet` (poller) keeps the current selection and
   *  never toggles the spinner; non-quiet (open / manual) re-selects the first
   *  file when nothing is selected. */
  refresh: (opts?: { quiet?: boolean }) => Promise<void>;
  reset: () => void;
}

// Stale-response guard. openDiff/setActiveRepo/closeDiff bump this; an in-flight
// derive or list whose token is stale drops its result (the user moved on).
let _req = 0;

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
            });
            return;
          }
          const panes = usePtyStore.getState().panes;
          const repos = await deriveRepos(session, panes, gitRepoRoot);
          if (req !== _req) return; // closed / re-opened while resolving
          set((s) => {
            s.repos = repos;
            s.activeRepo = repos[0] ?? null;
            s.files = [];
            s.selectedPath = null;
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
            const files = await gitChangedFiles(repo);
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

// src/store/mdStore.ts
//
// The Editor's tab model (Plan 010 Phase A). Despite the historical filename,
// tabs now hold ANY text/code file, not just Markdown — `kind` distinguishes
// the two: markdown tabs keep the rendered-preview toggle, code tabs are a
// plain syntax-highlighted editor. Oversized files open `readOnly`. Each open
// tab is watched on disk (editorWatch) so external edits by an agent surface
// as a silent reload (clean tab) or a conflict bar (dirty tab).
import { create } from "zustand";
import { devtools, persist, createJSONStorage } from "zustand/middleware";
import { immer } from "zustand/middleware/immer";

import { readTextFile, readEditorFile, writeTextFile } from "@/lib/fsClient";
import { findFileByName } from "@/lib/fileSearch";
import { watchEditorFile, unwatchEditorFile } from "@/lib/editorWatch";
import { tauriPersistStorage } from "@/lib/persistStorage";
import { useConfirmStore } from "@/store/confirmStore";
import { useToastStore } from "@/store/toastStore";

export type EditorTabKind = "markdown" | "code";

export interface MdTab {
  id: string;
  path: string;
  content: string;
  dirty: boolean;
  /** markdown → preview toggle available; code → plain editor only. */
  kind: EditorTabKind;
  /** Oversized file (> 1.5 MB): editable disabled, banner shown. */
  readOnly: boolean;
  /** Set when the file changed on disk while this tab has unsaved edits. Holds
   *  the disk content so [Reload] can apply it. Null when in sync. */
  conflict: { diskContent: string } | null;
}

/** Markdown file extensions — everything else opens as a `code` tab. */
const MARKDOWN_RE = /\.(md|markdown|mdx|mdown|mkd)$/i;
export function tabKindForPath(path: string): EditorTabKind {
  return MARKDOWN_RE.test(path) ? "markdown" : "code";
}

// Self-write suppression (Plan 010 §3). After an in-app Save we stamp the
// path; a `file-changed` echo arriving within the window is ignored so our own
// write never raises the conflict bar. Content-comparison in handleExternalChange
// is the backstop; this flag covers the save-race where the user typed mid-write
// (buffer ≠ what we wrote to disk) which content-compare alone would misread.
const SELF_WRITE_SUPPRESS_MS = 1200;
const selfWriteAt = new Map<string, number>();
function markSelfWrite(path: string): void {
  selfWriteAt.set(path, Date.now());
}
function isSelfWrite(path: string): boolean {
  const at = selfWriteAt.get(path);
  return at !== undefined && Date.now() - at < SELF_WRITE_SUPPRESS_MS;
}

export interface QuickViewerState {
  open: boolean;
  path: string | null;
  content: string;
}

export type MdEditorMode = "off" | "full";

export type FocusedSurface =
  | "terminal"
  | "md-editor"
  | "quick-viewer"
  | "sidebar"
  | null;

export interface MdStoreState {
  mdEditorMode: MdEditorMode;
  tabs: MdTab[];
  activeTabId: string | null;
  quickViewer: QuickViewerState;
  focusedSurface: FocusedSurface;

  // Quick Viewer — read-only rendered HTML. Editing happens in MD Editor
  // Full View (openMdTab) to keep a single editing surface across the app.
  openMdInQuickViewer: (path: string) => Promise<void>;
  // Open the first candidate path that actually reads (terminal MD-link click).
  // `label` is the raw clicked text, used in the not-found toast. When every
  // candidate misses and `searchRoot` is given, fall back to searching that
  // folder for the clicked filename (agent printed a bare name in a subdir).
  openMdLinkInQuickViewer: (
    candidates: string[],
    label: string,
    searchRoot?: string | null
  ) => Promise<void>;
  closeQuickViewer: () => void;

  // Editor Full View (any text/code file)
  setMdEditorMode: (mode: MdEditorMode) => void;
  openMdTab: (path: string) => Promise<void>;
  setActiveTab: (id: string) => void;
  setTabContent: (id: string, content: string) => void;
  saveMdTab: (id: string) => Promise<void>;
  closeMdTab: (id: string) => Promise<boolean>;

  // External-change handling (Plan 010 §3). handleExternalChange is invoked by
  // the Rust `file-changed` bridge; the other two resolve a raised conflict.
  handleExternalChange: (path: string) => Promise<void>;
  reloadTab: (id: string) => void;
  keepConflictMine: (id: string) => void;

  setFocusedSurface: (s: FocusedSurface) => void;

  reset: () => void;
}

let _tabSeq = 0;
const nextTabId = () => `mdtab-${++_tabSeq}`;
let _qvReq = 0;

export const useMdStore = create<MdStoreState>()(
  devtools(
    persist(
      immer((set, get) => ({
      mdEditorMode: "off",
      tabs: [],
      activeTabId: null,
      quickViewer: { open: false, path: null, content: "" },
      focusedSurface: null,

      // Try each candidate in order; open the Quick Viewer on the first that
      // reads. _qvReq makes it last-call-wins so a newer click supersedes an
      // in-flight read. If none read (path doesn't exist / resolved against the
      // wrong cwd), surface a toast instead of opening a broken viewer — the
      // "precision" half of MD-link opening.
      openMdLinkInQuickViewer: async (candidates, label, searchRoot) => {
        const req = ++_qvReq;
        // 1. Direct candidates (cwd / session folder joins).
        for (const path of candidates) {
          let content: string;
          try {
            content = await readTextFile(path);
          } catch {
            if (req !== _qvReq) return; // a newer open superseded this read
            continue; // try the next candidate root
          }
          if (req !== _qvReq) return;
          set((s) => {
            s.quickViewer = { open: true, path, content };
          });
          return;
        }
        // 2. Fallback: the agent likely printed a bare filename for a file in a
        // subfolder (e.g. "PLAN.md" living at docs/PLAN.md). Search the session
        // folder for that basename and open the shallowest match.
        if (searchRoot) {
          const basename = label.split(/[/\\]/).pop() ?? label;
          const found = await findFileByName(searchRoot, basename);
          if (req !== _qvReq) return;
          if (found) {
            try {
              const content = await readTextFile(found);
              if (req !== _qvReq) return;
              set((s) => {
                s.quickViewer = { open: true, path: found, content };
              });
              return;
            } catch {
              // fall through to the not-found toast
            }
          }
        }
        if (req !== _qvReq) return;
        useToastStore
          .getState()
          .push({ severity: "warn", message: `Couldn't open ${label}` });
      },
      openMdInQuickViewer: async (path) => {
        // Sidebar / shortcut opens are exact paths — no search fallback needed.
        await get().openMdLinkInQuickViewer(
          [path],
          path.split(/[/\\]/).pop() ?? path
        );
      },
      closeQuickViewer: () => {
        set((s) => {
          s.quickViewer = { open: false, path: null, content: "" };
        });
      },

      setMdEditorMode: (mode) =>
        set((s) => {
          s.mdEditorMode = mode;
        }),
      openMdTab: async (path) => {
        const existing = get().tabs.find((t) => t.path === path);
        if (existing) {
          set((s) => {
            s.activeTabId = existing.id;
            s.mdEditorMode = "full";
          });
          return;
        }
        // Probe: refuse binaries, open oversized files read-only (Plan 010 §2).
        const probe = await readEditorFile(path);
        if (probe.binary) {
          useToastStore.getState().push({
            severity: "warn",
            message: `Can't open ${path.split(/[/\\]/).pop() ?? path} — looks like a binary file`,
          });
          return;
        }
        // Re-check after the await — a concurrent open of the same path may
        // have already created the tab while we were reading.
        const already = get().tabs.find((t) => t.path === path);
        if (already) {
          set((s) => {
            s.activeTabId = already.id;
            s.mdEditorMode = "full";
          });
          return;
        }
        const id = nextTabId();
        set((s) => {
          s.tabs.push({
            id,
            path,
            content: probe.content,
            dirty: false,
            kind: tabKindForPath(path),
            readOnly: probe.tooLarge,
            conflict: null,
          });
          s.activeTabId = id;
          s.mdEditorMode = "full";
        });
        // Watch the file so an agent's external edits surface (fire-and-forget;
        // watching is best-effort — a failure just means no live reload).
        void watchEditorFile(path).catch(() => undefined);
      },
      setActiveTab: (id) =>
        set((s) => {
          s.activeTabId = id;
        }),
      setTabContent: (id, content) =>
        set((s) => {
          const t = s.tabs.find((t) => t.id === id);
          // Read-only (oversized) tabs never take edits — ignore.
          if (t && !t.readOnly) {
            t.content = content;
            t.dirty = true;
          }
        }),
      saveMdTab: async (id) => {
        const t = get().tabs.find((t) => t.id === id);
        if (!t) return;
        if (t.readOnly) return; // oversized files are view-only
        const written = t.content; // snapshot exactly what we write to disk
        // Stamp BEFORE the write so the watcher echo (which can arrive the
        // instant the write lands) is recognised as our own, not an external
        // change. Re-stamped after so a slow write still covers the echo.
        markSelfWrite(t.path);
        try {
          await writeTextFile(t.path, written);
          markSelfWrite(t.path);
          set((s) => {
            const tt = s.tabs.find((t) => t.id === id);
            // Only clear dirty if the content hasn't changed since this write
            // started; otherwise the user typed during the save and edits remain
            // unsaved.
            if (tt && tt.content === written) {
              tt.dirty = false;
              // Saving is a resolution: our version is now on disk.
              tt.conflict = null;
            }
          });
          useToastStore.getState().push({
            severity: "success",
            message: `Saved ${t.path.split(/[/\\]/).pop() ?? t.path}`,
          });
        } catch (err) {
          // Toast is the user-facing surface; no rethrow because the only
          // caller (useKeyboardShortcuts.saveActiveMdTab) calls this via
          // `void` and doesn't await — a rethrow becomes an unhandled
          // promise rejection that just adds console noise on top of the
          // already-visible error toast.
          useToastStore.getState().push({
            severity: "error",
            message: `Save failed: ${err instanceof Error ? err.message : String(err)}`,
          });
        }
      },
      closeMdTab: async (id) => {
        const closing = get().tabs.find((t) => t.id === id);
        if (!closing) return false;
        if (closing.dirty) {
          const fileName = closing.path.split(/[/\\]/).pop() ?? closing.path;
          const ok = await useConfirmStore.getState().confirm({
            title: "Discard unsaved changes?",
            message: `${fileName} has unsaved changes. Close it and discard those edits?`,
            confirmLabel: "Discard",
            cancelLabel: "Keep Editing",
            danger: true,
          });
          if (!ok) return false;
        }
        set((s) => {
          const idx = s.tabs.findIndex((t) => t.id === id);
          if (idx === -1) return;
          s.tabs.splice(idx, 1);
          if (s.activeTabId === id) {
            s.activeTabId =
              s.tabs.length === 0 ? null : s.tabs[Math.min(idx, s.tabs.length - 1)].id;
          }
          if (s.tabs.length === 0) s.mdEditorMode = "off";
        });
        // Stop watching the closed file (unless another tab still holds the
        // same path — dedup guarantees at most one tab per path, so it's safe).
        void unwatchEditorFile(closing.path).catch(() => undefined);
        return true;
      },

      // The Rust `file-changed` bridge calls this with the changed path.
      //   - our own save echoing back → ignored (self-write flag / content ==)
      //   - clean tab                 → silent reload from disk
      //   - dirty tab                 → raise the conflict bar
      handleExternalChange: async (path) => {
        const tab = get().tabs.find((t) => t.path === path);
        if (!tab) return; // not open (or closed mid-flight)
        if (isSelfWrite(path)) return; // our Save is echoing back
        let disk: string;
        try {
          disk = await readTextFile(path);
        } catch {
          return; // transient (mid-rename); the next event will retry
        }
        const cur = get().tabs.find((t) => t.path === path);
        if (!cur) return;
        if (disk === cur.content) return; // no real difference (incl. our write)
        if (!cur.dirty) {
          // Clean tab: adopt disk silently — the buffer had no edits to lose.
          set((s) => {
            const t = s.tabs.find((t) => t.id === cur.id);
            if (t) {
              t.content = disk;
              t.dirty = false;
              t.conflict = null;
            }
          });
        } else {
          // Dirty tab: don't clobber the user's edits — surface the choice.
          set((s) => {
            const t = s.tabs.find((t) => t.id === cur.id);
            if (t) t.conflict = { diskContent: disk };
          });
        }
      },
      reloadTab: (id) =>
        set((s) => {
          const t = s.tabs.find((t) => t.id === id);
          if (!t || !t.conflict) return;
          t.content = t.conflict.diskContent;
          t.dirty = false;
          t.conflict = null;
        }),
      keepConflictMine: (id) =>
        set((s) => {
          const t = s.tabs.find((t) => t.id === id);
          // Keep the buffer (still dirty); just dismiss the bar. The user's
          // next Save overwrites disk with their version.
          if (t) t.conflict = null;
        }),

      setFocusedSurface: (focusedSurface) =>
        set((s) => {
          s.focusedSurface = focusedSurface;
        }),

      reset: () => {
        // Release any open-file watchers before dropping the tabs.
        for (const t of get().tabs) {
          void unwatchEditorFile(t.path).catch(() => undefined);
        }
        selfWriteAt.clear();
        set((s) => {
          s.mdEditorMode = "off";
          s.tabs = [];
          s.activeTabId = null;
          s.quickViewer = { open: false, path: null, content: "" };
          s.focusedSurface = null;
        });
      },
    })),
      {
        name: "md",
        storage: createJSONStorage(() => tauriPersistStorage("lume-store.json")),
        version: 1,
        // tabs / quickViewer / focusedSurface are ephemeral session state.
        // Only mdEditorMode survives restart (DESIGN.md §4 EXCLUDED list).
        partialize: (state) => ({ mdEditorMode: state.mdEditorMode }),
      }
    ),
    { name: "mdStore" }
  )
);

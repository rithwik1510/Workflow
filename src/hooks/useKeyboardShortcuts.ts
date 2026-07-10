// Lume keyboard shortcuts (W2-P3 — DESIGN.md §7 + §12 Weekend 2 #3).
//
// We install ONE window-level keydown listener (capture phase) so the
// shortcuts fire before xterm.js consumes the keystroke. Without capture,
// xterm gets first dibs on every key when a Terminal Pane has DOM focus
// and our Ctrl+Alt+→ would land inside the shell instead of triggering a
// split.
//
// Shortcuts (focused-surface-aware will land in Weekend 3 with MD Editor;
// for now everything routes to the layout / terminal store):
//
//   Ctrl+Alt+→           split focused pane right
//   Ctrl+Alt+↓           split focused pane down
//   Ctrl+Alt+↑           split focused pane up
//   Ctrl+→ / ← / ↑ / ↓   move focus geometrically
//   Ctrl+W               close focused pane (last-pane lock holds)

import { useEffect } from "react";

import { useLayoutStore } from "@/store/layoutStore";
import { useMdStore } from "@/store/mdStore";
import { usePaneSearchStore } from "@/store/paneSearchStore";
import { useDiffStore } from "@/store/diffStore";
import { usePreviewStore } from "@/store/previewStore";
import { useSessionsStore, groupedSessions } from "@/store/sessionsStore";
import { useSidebarStore } from "@/store/sidebarStore";
import { useConfirmStore } from "@/store/confirmStore";
import { useSettingsModalStore } from "@/store/settingsModalStore";
import { useShortcutsModalStore } from "@/store/shortcutsModalStore";
import type { FocusDirection, SplitDirection } from "@/store/layout/tree";
import { leaves } from "@/store/layout/tree";
import { nextPaneId } from "@/lib/paneIds";
import { closeBusyPaneConfirm, closeLastPaneInSessionConfirm } from "@/lib/confirmStrings";
import { pickAndCreateSession } from "@/lib/sessions/sessionEntryFlows";
import { emitSessionNavigation } from "@/sessions/coachNav";
import { pickFolder, pickEditorFile } from "@/lib/dialogClient";
import { isPtyBusy } from "@/terminals/ptyClient";
import { shouldSkipShortcut } from "@/hooks/shortcutTarget";

// PaneId generation lives in @/lib/paneIds so the TopBar Split button and
// the keyboard layer share a single counter (no Date.now() collisions).
export { reservePaneIdsAtLeast } from "@/lib/paneIds";

// ---------- Shortcut handler ----------

interface Shortcut {
  match: (e: KeyboardEvent) => boolean;
  /** Returns true if the shortcut was handled (we'll call preventDefault). */
  run: () => boolean;
}

function isCtrlOnly(e: KeyboardEvent): boolean {
  return e.ctrlKey && !e.altKey && !e.shiftKey && !e.metaKey;
}

function isCtrlAlt(e: KeyboardEvent): boolean {
  return e.ctrlKey && e.altKey && !e.shiftKey && !e.metaKey;
}

function focusedPaneOrNull(): string | null {
  return useLayoutStore.getState().focusedPaneId;
}

function splitFromFocused(direction: SplitDirection): boolean {
  const focused = focusedPaneOrNull();
  if (focused === null) return false;
  const id = nextPaneId();
  useLayoutStore.getState().splitPane(direction, id, focused);
  return true;
}

function moveFocus(direction: FocusDirection): boolean {
  if (focusedPaneOrNull() === null) return false;
  useLayoutStore.getState().moveFocus(direction);
  return true;
}

async function closeFocusedAsync(): Promise<boolean> {
  // Read everything from the active session so last-pane semantics can branch
  // to stopSession instead of the old hard last-pane lock.
  const sessions = useSessionsStore.getState();
  const activeId = sessions.activeSessionId;
  if (!activeId) return false;
  const session = sessions.sessions[activeId];
  if (!session || !session.layoutRoot) return false;
  const focused = session.focusedPaneId;
  if (focused === null) return false;

  // CONTEXT.md invariant 3: gate Ctrl+W behind the active-process confirm
  // dialog, identical to the × button on the pane.
  try {
    const busy = await isPtyBusy(focused);
    if (busy) {
      const ok = await useConfirmStore.getState().confirm(closeBusyPaneConfirm(focused));
      if (!ok) return false;
    }
  } catch (err) {
    console.warn("isPtyBusy check failed", err);
  }

  // Last-pane semantics: closing the only pane stops the session (kept in the
  // sidebar for reactivation) rather than being a no-op. Separate confirm so
  // the user understands the session — not just the pane — is going away.
  if (leaves(session.layoutRoot).length === 1) {
    const ok = await useConfirmStore
      .getState()
      .confirm(closeLastPaneInSessionConfirm(session.name));
    if (!ok) return false;
    useSessionsStore.getState().stopSession(activeId);
    return true;
  }

  useLayoutStore.getState().closePane(focused);
  return true;
}

// ---------- Session navigation (Phase 7) ----------
//
// Cycle / jump operate on the sidebar's flattened render order: groups in
// groupedSessions() order, sessions within each group, group headers skipped.

function cycleSession(delta: 1 | -1): boolean {
  const state = useSessionsStore.getState();
  const flat = groupedSessions(state).flatMap((g) => g.sessions);
  if (flat.length === 0) return false;
  const idx = state.activeSessionId
    ? flat.findIndex((s) => s.id === state.activeSessionId)
    : -1;
  const nextIdx = (idx + delta + flat.length) % flat.length;
  // Coach: keyboard session cycling is a DELIBERATE navigation entry point
  // (Plan 014 §5). Emit BEFORE enterSession so `from` is the outgoing session;
  // the seam drops the non-friction cases (split open / split-pair reopen).
  emitSessionNavigation(flat[nextIdx]!.id, "keyboard");
  // enterSession (not activateSession) so cycling onto a grouped session
  // re-opens its split, matching a sidebar click.
  useSessionsStore.getState().enterSession(flat[nextIdx]!.id);
  return true;
}

function jumpToSession(n: number): boolean {
  const state = useSessionsStore.getState();
  const flat = groupedSessions(state).flatMap((g) => g.sessions);
  if (n < 1 || n > flat.length) return false;
  useSessionsStore.getState().enterSession(flat[n - 1]!.id);
  return true;
}

function newSessionViaPicker(): boolean {
  void pickAndCreateSession();
  return true;
}

function toggleActiveFileTree(): boolean {
  const activeId = useSessionsStore.getState().activeSessionId;
  if (!activeId) return false;
  useSessionsStore.getState().toggleFileTree(activeId);
  return true;
}

function closeFocused(): boolean {
  // Fire-and-forget the async path; the shortcut returns true synchronously
  // to consume the keystroke. The async close + confirm dialog happen
  // shortly after.
  void closeFocusedAsync();
  return true;
}

function toggleSidebar(): boolean {
  useSidebarStore.getState().toggleSidebar();
  return true;
}

// Ctrl+F — open the focused terminal's scrollback search (Plan 012). ONLY when
// a terminal is the focused surface: the MD editor keeps CodeMirror's own find
// (and shouldSkipShortcut already yields to CodeMirror when it has DOM focus).
// Returns false when not a terminal so the keystroke isn't consumed.
export function openTerminalSearch(): boolean {
  if (useMdStore.getState().focusedSurface !== "terminal") return false;
  const focused = useLayoutStore.getState().focusedPaneId;
  if (focused === null) return false;
  usePaneSearchStore.getState().open(focused);
  return true;
}

function openShortcutsModal(): boolean {
  useShortcutsModalStore.getState().openModal();
  return true;
}

function toggleQuickViewer(): boolean {
  const qv = useMdStore.getState().quickViewer;
  const activeId = useSessionsStore.getState().activeSessionId;
  // "Open" only counts if the viewer belongs to the active session — a viewer
  // owned by another project is hidden here, so the toggle should reopen it in
  // THIS session, not close someone else's panel.
  const visibleHere = qv.open && qv.sessionId === activeId;
  if (visibleHere) {
    useMdStore.getState().closeQuickViewer();
  } else if (qv.path !== null) {
    // Reopen the last file — openMdInQuickViewer re-stamps the active session as
    // owner, so it shows here (covers both closed and open-in-another-session).
    void useMdStore
      .getState()
      .openMdInQuickViewer(qv.path)
      .catch((err) => console.error("openMdInQuickViewer failed", err));
  }
  return true;
}

function togglePreview(): boolean {
  const s = usePreviewStore.getState();
  if (s.open) s.closePreview();
  else s.openPreview();
  return true;
}

// Ctrl+Shift+D — toggle the git Diff tab (Plan 010 Phase B). NOT Ctrl+D: that
// is EOF in a terminal and our capture-phase listener does not skip .xterm
// (shortcutTarget), so a plain Ctrl+D binding would swallow EOF from the shell.
// Ctrl+Shift+D joins the other surface toggles (Quick Viewer Ctrl+Shift+M,
// Preview Ctrl+Shift+L, file drawer Ctrl+Shift+E). openDiff derives the repos.
function toggleDiff(): boolean {
  const d = useDiffStore.getState();
  if (d.open) d.closeDiff();
  else void d.openDiff();
  return true;
}

// Ctrl+E — toggle MD Editor Full View. Fires regardless of current mode.
function toggleMdMode(): boolean {
  const cur = useMdStore.getState().mdEditorMode;
  useMdStore.getState().setMdEditorMode(cur === "full" ? "off" : "full");
  return true;
}

// Ctrl+O — open any file as an Editor tab via the native OS picker (matches
// the Editor's "Open file" button). Returns true synchronously to consume the
// keystroke; the picker + open happen async.
function openMdFromPicker(): boolean {
  void pickEditorFile()
    .then((path) => {
      if (path) return useMdStore.getState().openMdTab(path);
      return undefined;
    })
    .catch((err) => console.error("openMdTab failed", err));
  return true;
}

// Ctrl+S — save the active MD Editor tab. Returns false when not in MD Full
// View so other Ctrl+S handlers (none in v0.1, but defensive) can still fire.
function saveActiveMdTab(): boolean {
  if (useMdStore.getState().mdEditorMode !== "full") return false;
  const active = useMdStore.getState().activeTabId;
  if (active === null) return false;
  void useMdStore.getState().saveMdTab(active);
  return true;
}

// Ctrl+W — close the active MD Editor tab when in Full View. Returns false
// otherwise so the existing close-pane handler keeps working.
function closeActiveMdTab(): boolean {
  if (useMdStore.getState().mdEditorMode !== "full") return false;
  const active = useMdStore.getState().activeTabId;
  if (active === null) return false;
  void useMdStore.getState().closeMdTab(active);
  return true;
}

// Ctrl+Tab — cycle MD Editor tabs. Only fires in Full View; otherwise
// returns false so the keystroke falls through to native tab order.
function cycleMdTabs(delta: 1 | -1 = 1): boolean {
  if (useMdStore.getState().mdEditorMode !== "full") return false;
  const { tabs, activeTabId, setActiveTab } = useMdStore.getState();
  if (tabs.length === 0) return false;
  const idx = tabs.findIndex((t) => t.id === activeTabId);
  const safeIdx = idx === -1 ? 0 : idx;
  const next = tabs[(safeIdx + delta + tabs.length) % tabs.length];
  setActiveTab(next.id);
  return true;
}

function isMdFullMode(): boolean {
  return useMdStore.getState().mdEditorMode === "full";
}

function shouldHandleMdShortcutFromEditable(e: KeyboardEvent): boolean {
  if (!isMdFullMode()) return false;
  if (isCtrlOnly(e) && e.key === "Tab") return true;
  if (e.ctrlKey && e.shiftKey && !e.altKey && !e.metaKey && e.key === "Tab") return true;
  if (isCtrlOnly(e)) {
    const key = e.key.toLowerCase();
    return key === "e" || key === "s" || key === "w";
  }
  return false;
}

// ---------- Chord state (Ctrl+K-prefixed shortcuts) ----------
//
// The first key (Ctrl+K alone) arms the chord; the next keypress
// resolves it. State resets after CHORD_TIMEOUT_MS of inactivity so a
// stale prefix doesn't surprise the user on the next keystroke.

const CHORD_TIMEOUT_MS = 1500;

// Chord state for Ctrl+K-prefixed shortcuts. Module-scope mutable state —
// assumes useKeyboardShortcuts mounts in exactly one component (App.tsx).
// If this ever needs to mount in multiple places, lift to a Zustand store.
let chordPrefix: "ctrl-k" | null = null;
let chordTimer: number | null = null;

function armChord(prefix: "ctrl-k"): void {
  chordPrefix = prefix;
  if (chordTimer !== null) window.clearTimeout(chordTimer);
  chordTimer = window.setTimeout(() => {
    chordPrefix = null;
    chordTimer = null;
  }, CHORD_TIMEOUT_MS);
}

function clearChord(): void {
  chordPrefix = null;
  if (chordTimer !== null) {
    window.clearTimeout(chordTimer);
    chordTimer = null;
  }
}

function openFolderViaPicker(): void {
  void (async () => {
    try {
      const folder = await pickFolder();
      if (folder !== null) {
        useSidebarStore.getState().setWorkspaceFolder(folder);
      }
    } catch (err) {
      console.error("Open Folder failed", err);
    }
  })();
}

const SHORTCUTS: Shortcut[] = [
  // Splits — Ctrl+Alt+arrow
  { match: (e) => isCtrlAlt(e) && e.key === "ArrowRight", run: () => splitFromFocused("right") },
  { match: (e) => isCtrlAlt(e) && e.key === "ArrowDown", run: () => splitFromFocused("down") },
  { match: (e) => isCtrlAlt(e) && e.key === "ArrowUp", run: () => splitFromFocused("up") },

  // Zoom the focused pane — Ctrl+Alt+Z, joining the Ctrl+Alt pane family
  // (tmux `prefix z`). Toggles; layoutStore auto-restores the grid on any
  // focus move, split, close, or session switch, so the keyboard can never
  // land in a hidden pane.
  {
    match: (e) => isCtrlAlt(e) && (e.key === "z" || e.key === "Z"),
    run: () => {
      useLayoutStore.getState().toggleZoomPane();
      return true;
    },
  },

  // Focus moves — Ctrl+arrow
  { match: (e) => isCtrlOnly(e) && e.key === "ArrowRight", run: () => moveFocus("right") },
  { match: (e) => isCtrlOnly(e) && e.key === "ArrowLeft", run: () => moveFocus("left") },
  { match: (e) => isCtrlOnly(e) && e.key === "ArrowUp", run: () => moveFocus("up") },
  { match: (e) => isCtrlOnly(e) && e.key === "ArrowDown", run: () => moveFocus("down") },

  // Toggle Sidebar — Ctrl+B (DESIGN.md §7).
  {
    match: (e) => isCtrlOnly(e) && (e.key === "b" || e.key === "B"),
    run: () => toggleSidebar(),
  },

  // Find in terminal — Ctrl+F. Gated on terminal focus inside run(); a no-op
  // (returns false, keystroke not consumed) on any other surface so the MD
  // editor's CodeMirror find still works.
  {
    match: (e) => isCtrlOnly(e) && (e.key === "f" || e.key === "F"),
    run: () => openTerminalSearch(),
  },

  // Toggle MD Quick Viewer — Ctrl+Shift+M (must come before Ctrl+W so the
  // narrower shift-modifier match isn't shadowed).
  {
    match: (e) =>
      e.ctrlKey && e.shiftKey && !e.altKey && !e.metaKey && (e.key === "M" || e.key === "m"),
    run: () => toggleQuickViewer(),
  },

  // Toggle the localhost Preview panel — Ctrl+Shift+L.
  {
    match: (e) =>
      e.ctrlKey && e.shiftKey && !e.altKey && !e.metaKey && (e.key === "L" || e.key === "l"),
    run: () => togglePreview(),
  },

  // Toggle the git Diff tab — Ctrl+Shift+D (see toggleDiff for why not Ctrl+D).
  {
    match: (e) =>
      e.ctrlKey && e.shiftKey && !e.altKey && !e.metaKey && (e.key === "D" || e.key === "d"),
    run: () => toggleDiff(),
  },

  // Show keyboard shortcuts — Ctrl+? (DESIGN.md §7). On most keyboards
  // ? is Shift+/, so the OS may report e.key as "?" or "/" depending on
  // layout. Accept both. Ordered with the other surface toggles, BEFORE
  // the Ctrl+W pane-close entry below.
  {
    match: (e) =>
      e.ctrlKey && e.shiftKey && !e.altKey && !e.metaKey && (e.key === "?" || e.key === "/"),
    run: () => openShortcutsModal(),
  },

  // Open Settings — Ctrl+, (mirrors the topbar gear button).
  {
    match: (e) => isCtrlOnly(e) && e.key === ",",
    run: () => {
      useSettingsModalStore.getState().openModal();
      return true;
    },
  },

  // ---- MD Editor Full View shortcuts (Phase 6) ----
  // These must come BEFORE the Ctrl+W close-pane entry so MD-gated handlers
  // win when in Full View. When not in Full View, the `match` predicates for
  // Ctrl+S / Ctrl+W / Ctrl+Tab return false so the loop falls through to the
  // pane-level Ctrl+W (and Ctrl+S / Ctrl+Tab become no-ops, matching v0.1).

  // Ctrl+E — toggle MD Editor mode (fires unconditionally)
  { match: (e) => isCtrlOnly(e) && (e.key === "e" || e.key === "E"), run: () => toggleMdMode() },

  // Chord prefix: Ctrl+K alone arms the chord. The next keypress resolves
  // it. Released after 1.5s if no follow-up. Must be ordered BEFORE the
  // plain Ctrl+O entry so Ctrl+K → Ctrl+O resolves below instead of
  // falling into openMdFromPicker.
  {
    match: (e) =>
      isCtrlOnly(e) && (e.key === "k" || e.key === "K") && chordPrefix === null,
    run: () => {
      armChord("ctrl-k");
      return true;
    },
  },

  // Resolution: Ctrl+K → Ctrl+O opens the OS folder picker. Must come
  // BEFORE the plain Ctrl+O entry below.
  {
    match: (e) =>
      chordPrefix === "ctrl-k" && isCtrlOnly(e) && (e.key === "o" || e.key === "O"),
    run: () => {
      clearChord();
      openFolderViaPicker();
      return true;
    },
  },

  // Ctrl+O — open .md file via the native picker (fires unconditionally)
  { match: (e) => isCtrlOnly(e) && (e.key === "o" || e.key === "O"), run: () => openMdFromPicker() },

  // Ctrl+S — save active MD tab (gated on Full View)
  {
    match: (e) => isCtrlOnly(e) && (e.key === "s" || e.key === "S") && isMdFullMode(),
    run: () => saveActiveMdTab(),
  },

  // Ctrl+W — close active MD tab (gated on Full View; existing Ctrl+W
  // close-pane entry below still handles the non-MD case)
  {
    match: (e) => isCtrlOnly(e) && (e.key === "w" || e.key === "W") && isMdFullMode(),
    run: () => closeActiveMdTab(),
  },

  // Ctrl+Tab — cycle MD tabs (gated on Full View)
  {
    match: (e) => isCtrlOnly(e) && e.key === "Tab" && isMdFullMode(),
    run: () => cycleMdTabs(1),
  },
  // Ctrl+Shift+Tab — cycle MD tabs backward (gated on Full View)
  {
    match: (e) =>
      e.ctrlKey && e.shiftKey && !e.altKey && !e.metaKey && e.key === "Tab" && isMdFullMode(),
    run: () => cycleMdTabs(-1),
  },

  // ---- Session navigation (Phase 7) ----

  // New session — Ctrl+Shift+T (opens folder picker → always create).
  {
    match: (e) =>
      e.ctrlKey && e.shiftKey && !e.altKey && !e.metaKey && (e.key === "T" || e.key === "t"),
    run: () => newSessionViaPicker(),
  },

  // Toggle file drawer — Ctrl+Shift+E (mirrors the topbar 🗂 button).
  {
    match: (e) =>
      e.ctrlKey && e.shiftKey && !e.altKey && !e.metaKey && (e.key === "E" || e.key === "e"),
    run: () => toggleActiveFileTree(),
  },

  // Cycle sessions — Ctrl+Tab forward / Ctrl+Shift+Tab back, in flattened
  // sidebar order. The forward entry MUST come AFTER the MD-gated Ctrl+Tab
  // above so MD tab cycling wins in Full View; outside Full View that match
  // returns false and the keystroke falls through to here.
  {
    match: (e) => isCtrlOnly(e) && e.key === "Tab",
    run: () => cycleSession(1),
  },
  {
    match: (e) => e.ctrlKey && e.shiftKey && !e.altKey && !e.metaKey && e.key === "Tab",
    run: () => cycleSession(-1),
  },

  // Jump to session N — Ctrl+1 .. Ctrl+9 (flattened sidebar order, 1-based).
  ...Array.from({ length: 9 }, (_, i) => ({
    match: (e: KeyboardEvent) => isCtrlOnly(e) && e.key === String(i + 1),
    run: () => jumpToSession(i + 1),
  })),

  // Close — Ctrl+W (pane close; runs when NOT in MD Full View because the
  // MD-gated entry above will have matched first otherwise)
  { match: (e) => isCtrlOnly(e) && (e.key === "w" || e.key === "W"), run: () => closeFocused() },
];

export function useKeyboardShortcuts(): void {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (shouldSkipShortcut(e.target) && !shouldHandleMdShortcutFromEditable(e)) return;
      for (const s of SHORTCUTS) {
        if (s.match(e)) {
          if (s.run()) {
            e.preventDefault();
            e.stopPropagation();
          }
          return;
        }
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      // Drop any armed chord timer on unmount so a pending Ctrl+K
      // prefix doesn't leak across hot reloads.
      clearChord();
    };
  }, []);
}

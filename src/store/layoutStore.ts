// layoutStore — Façade over sessionsStore (Phase 1 of session manager).
//
// Every consumer (PaneTree, useKeyboardShortcuts, orchestrator, StatusBar,
// SplitMenu, TerminalPane, App) still imports useLayoutStore and calls
// splitPane / closePane / focusPane / resizeSplit / moveFocus and reads
// root / focusedPaneId just like before. Those reads and writes are routed
// through sessionsStore.sessions[activeSessionId].
//
// When activeSessionId is null (cold start, all-stopped), reads return null
// and writes are no-ops.
//
// This file used to OWN the layout tree directly (W2). The data lives in
// sessionsStore now; this is Pattern B (mirrored state): we keep `root` and
// `focusedPaneId` as real fields on the layoutStore and bridge sessionsStore
// mutations into setState({...}) calls. This preserves normal Zustand
// subscriber semantics for every existing consumer.
//
// The previous owner-store enforced a "last-pane lock" at this layer
// (closing the only leaf is a no-op). That lock is preserved here. The
// "last pane in session → stopSession" wiring will arrive in Phase 7 via
// the Ctrl+W keyboard shortcut, NOT in this façade.

import { create } from "zustand";
import { devtools, persist, createJSONStorage } from "zustand/middleware";

import type { PaneId } from "@/types";
import { tauriPersistStorage } from "@/lib/persistStorage";
import {
  type LayoutNode,
  type SplitDirection,
  type FocusDirection,
  contains,
  splitPane as splitPaneOp,
  closePane as closePaneOp,
  resizeSplit as resizeSplitOp,
  moveFocus as moveFocusOp,
  leaf,
  leaves,
  clampRatio,
} from "./layout/tree";
import { useSessionsStore } from "@/store/sessionsStore";

interface LayoutState {
  root: LayoutNode | null;
  focusedPaneId: PaneId | null;
  /** Pane temporarily filling the whole session area (tmux `prefix z`). PURE
   *  VIEW STATE, never persisted, owned by THIS store (not mirrored from
   *  sessionsStore): the layout tree is untouched while zoomed — PaneTree just
   *  collapses the sibling panels with CSS, so no terminal ever unmounts.
   *  Invariant (enforced in mirror + toggleZoomPane): zoom exists only while
   *  the zoomed pane IS the focused pane — any focus move, split, close, or
   *  session switch restores the grid, which is the tmux muscle memory. */
  zoomedPaneId: PaneId | null;
}

interface LayoutActions {
  initWithFirstPane: (paneId: PaneId) => void;
  splitPane: (direction: SplitDirection, newPaneId: PaneId, targetId?: PaneId) => void;
  closePane: (paneId: PaneId) => void;
  focusPane: (paneId: PaneId) => void;
  moveFocus: (direction: FocusDirection) => void;
  resizeSplit: (a: PaneId, b: PaneId, ratio: number) => void;
  /** Toggle pane zoom (Ctrl+Alt+Z / the corner expand button). No pane id →
   *  the focused pane. No-ops on a single-leaf layout (nothing to zoom over). */
  toggleZoomPane: (paneId?: PaneId) => void;
  reset: () => void;
}

export type LayoutStore = LayoutState & LayoutActions;

// ─── Façade helpers ────────────────────────────────────────────────────────

function activeSession() {
  const s = useSessionsStore.getState();
  const id = s.activeSessionId;
  return id ? s.sessions[id] ?? null : null;
}

/**
 * Pick a sensible neighbour to focus when the focused leaf is being closed.
 * Strategy: the leaf adjacent to the closed one in DFS order, preferring the
 * one BEFORE it (so closing a pane feels like "stepping back" to its origin).
 */
function pickFocusAfterClose(
  newRoot: LayoutNode,
  closedId: PaneId,
  prevAllLeaves: PaneId[]
): PaneId {
  const idx = prevAllLeaves.indexOf(closedId);
  if (idx > 0) {
    const candidate = prevAllLeaves[idx - 1]!;
    if (contains(newRoot, candidate)) return candidate;
  }
  if (idx >= 0 && idx + 1 < prevAllLeaves.length) {
    const candidate = prevAllLeaves[idx + 1]!;
    if (contains(newRoot, candidate)) return candidate;
  }
  // Fallback: first remaining leaf.
  return leaves(newRoot)[0]!;
}

// ─── Store (Pattern B — mirrored state) ────────────────────────────────────

export const useLayoutStore = create<LayoutStore>()(
  devtools(
    persist(
      () => ({
        // Initial state is null/null on purpose. The bridge below is the
        // single source of truth — it runs synchronously right after the
        // store is created (initial mirror), and again on every
        // sessionsStore mutation. Avoids a race where reading sessionsStore
        // at module load returns pre-rehydration state.
        root: null as LayoutNode | null,
        focusedPaneId: null as PaneId | null,
        zoomedPaneId: null as PaneId | null,

        initWithFirstPane: (paneId) => {
          const sess = activeSession();
          if (!sess) return;
          if (sess.layoutRoot !== null) return;
          const sStore = useSessionsStore.getState();
          sStore.setLayoutRoot(sess.id, leaf(paneId));
          sStore.setFocusedPane(sess.id, paneId);
        },

        splitPane: (direction, newPaneId, targetId) => {
          const sess = activeSession();
          if (!sess) return;
          const sStore = useSessionsStore.getState();
          // Degenerate case: empty layout — behave like initWithFirstPane.
          if (sess.layoutRoot === null) {
            sStore.setLayoutRoot(sess.id, leaf(newPaneId));
            sStore.setFocusedPane(sess.id, newPaneId);
            return;
          }
          const target = targetId ?? sess.focusedPaneId;
          if (target === null) return;
          if (!contains(sess.layoutRoot, target)) return;
          if (contains(sess.layoutRoot, newPaneId)) return; // paneId must be unique
          const next = splitPaneOp(sess.layoutRoot, target, direction, newPaneId);
          sStore.setLayoutRoot(sess.id, next);
          sStore.setFocusedPane(sess.id, newPaneId);
        },

        closePane: (paneId) => {
          const sess = activeSession();
          if (!sess || !sess.layoutRoot) return;
          if (!contains(sess.layoutRoot, paneId)) return;
          const allLeaves = leaves(sess.layoutRoot);
          // Last-pane lock at this layer.
          if (allLeaves.length <= 1) return;
          const next = closePaneOp(sess.layoutRoot, paneId);
          if (next === null) return; // belt-and-suspenders
          const sStore = useSessionsStore.getState();
          sStore.setLayoutRoot(sess.id, next);
          if (sess.focusedPaneId === paneId) {
            sStore.setFocusedPane(sess.id, pickFocusAfterClose(next, paneId, allLeaves));
          }
        },

        focusPane: (paneId) => {
          const sess = activeSession();
          if (!sess || !sess.layoutRoot) return;
          if (!contains(sess.layoutRoot, paneId)) return;
          useSessionsStore.getState().setFocusedPane(sess.id, paneId);
        },

        moveFocus: (direction) => {
          const sess = activeSession();
          if (!sess || !sess.layoutRoot || sess.focusedPaneId === null) return;
          const next = moveFocusOp(sess.layoutRoot, sess.focusedPaneId, direction);
          useSessionsStore.getState().setFocusedPane(sess.id, next);
        },

        resizeSplit: (a, b, ratio) => {
          const sess = activeSession();
          if (!sess || !sess.layoutRoot) return;
          const next = resizeSplitOp(sess.layoutRoot, a, b, clampRatio(ratio));
          if (next !== sess.layoutRoot) {
            useSessionsStore.getState().setLayoutRoot(sess.id, next);
          }
        },

        toggleZoomPane: (paneId) => {
          const cur = useLayoutStore.getState();
          const target = paneId ?? cur.focusedPaneId;
          if (target !== null && cur.zoomedPaneId === target) {
            useLayoutStore.setState({ zoomedPaneId: null });
            return;
          }
          if (target === null || cur.root === null) return;
          if (!contains(cur.root, target)) return;
          if (leaves(cur.root).length <= 1) return; // nothing to zoom over
          useLayoutStore.setState({ zoomedPaneId: target });
          // Zoom implies keyboard ownership. Focus BEFORE the mirror next runs
          // would matter — but focusPane mutates sessionsStore, and by the time
          // mirror fires, zoomedPaneId === focusedPaneId, so the invariant holds.
          useLayoutStore.getState().focusPane(target);
        },

        reset: () => {
          // The zoom flag is the one field this store owns; everything else is
          // mirrored from sessionsStore (whose reset the bridge propagates).
          useLayoutStore.setState({ zoomedPaneId: null });
          useSessionsStore.getState().reset();
        },
      }),
      {
        // The data we expose is owned by sessionsStore — this façade persists
        // NOTHING (partialize → {}). As of Phase 8, App.tsx's hydration gate
        // moved to useSessionsStore.persist, so nothing reads this store's
        // .persist API anymore. The wrapper is now vestigial; it's kept only
        // to avoid re-indenting the whole store body for zero behavioural gain
        // (it writes an empty object, never meaningful state). version:2 also
        // discards any leftover v0.1 "layout" key on a migrating user's disk.
        name: "layout",
        storage: createJSONStorage(() => tauriPersistStorage("lume-store.json")),
        version: 2,
        partialize: () => ({}),
      }
    ),
    { name: "layout (façade)", enabled: import.meta.env.DEV }
  )
);

// ─── Bridge: forward sessionsStore changes to layoutStore subscribers ──────
// The bridge is the SINGLE source of truth for layoutStore.root /
// focusedPaneId. We call mirror() once synchronously below to seed initial
// state (covers HMR and the post-create read), then subscribe for every
// future sessionsStore mutation. Identity-based diff on the leaf values
// avoids notifying when nothing changed.
//
// Race avoided: previously the initial root/focus were computed in the
// create() initializer, which read useSessionsStore.getState() at module
// load. If sessionsStore's persist middleware rehydrated AFTER layoutStore
// was created, the initial values would be stale and the subscribe-only
// bridge wouldn't fire (it fires on changes). Now the bridge owns these
// fields end-to-end.
function mirror(state: ReturnType<typeof useSessionsStore.getState>) {
  const id = state.activeSessionId;
  const sess = id ? state.sessions[id] ?? null : null;
  const nextRoot = sess?.layoutRoot ?? null;
  const nextFocus = sess?.focusedPaneId ?? null;
  const cur = useLayoutStore.getState();
  // Zoom invariant: alive only while the zoomed pane exists in the (possibly
  // new) tree AND still owns focus. A focus move, split (which focuses the new
  // pane), close, or session switch therefore restores the grid — tmux
  // semantics, and it guarantees the keyboard never lands in a hidden pane.
  let nextZoom = cur.zoomedPaneId;
  if (
    nextZoom !== null &&
    (nextRoot === null || !contains(nextRoot, nextZoom) || nextFocus !== nextZoom)
  ) {
    nextZoom = null;
  }
  if (cur.root !== nextRoot || cur.focusedPaneId !== nextFocus || cur.zoomedPaneId !== nextZoom) {
    useLayoutStore.setState({ root: nextRoot, focusedPaneId: nextFocus, zoomedPaneId: nextZoom });
  }
}

// Initial mirror — covers the case where useSessionsStore already has
// non-empty state at this point (HMR, tests that pre-seed state).
mirror(useSessionsStore.getState());

// Ongoing mirror — every sessionsStore mutation flows through here.
useSessionsStore.subscribe((state) => mirror(state));

// Re-mirror after sessionsStore finishes rehydrating from disk. As of Phase 8
// sessionsStore.partialize persists real session data, so this hook is
// load-bearing: it guarantees layoutStore.root catches up to the rehydrated
// active session (or stays null on an all-stopped cold start) without waiting
// for the next mutation. Guarded for the case where persist isn't wired (tests).
if (typeof useSessionsStore.persist?.onFinishHydration === "function") {
  useSessionsStore.persist.onFinishHydration(() => {
    mirror(useSessionsStore.getState());
  });
}

// ─── Convenience exports preserved for compatibility ───────────────────────

export { leaves } from "./layout/tree";

/** Returns the paneIds in the ACTIVE session only. Kept for compatibility. */
export function getPaneIds(state: LayoutState): PaneId[] {
  return state.root === null ? [] : leaves(state.root);
}

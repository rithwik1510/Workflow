// sessionsStore — multi-named-per-folder sessions, source of truth for the
// session manager sidebar. See docs/superpowers/specs/2026-05-25-session-
// manager-sidebar.md §4 for the data model and §11 for the persistence
// contract.
//
// Lifecycle invariants:
//   - status is NEVER persisted; rehydration coerces every session to "stopped"
//   - activeSessionId is NEVER persisted; cold start = null (all-stopped)
//   - unread is transient; cleared on activate and on rehydrate
//   - PTY processes don't survive restart (DESIGN.md §1 invariant 5)
//
// `unread` is the single sidebar attention signal (see attentionTracker): a
// background session whose agent rang the terminal bell — i.e. it finished a
// turn or is asking for input — shows a dot. The dot is cleared the moment you
// open that session.
//
// Grouping is derived: every distinct folderPath across `sessions` forms a
// group. No separate Group entity — just label overrides and collapsed-state,
// keyed by folderPath.

import { create } from "zustand";
import { devtools, persist, createJSONStorage } from "zustand/middleware";
import { immer } from "zustand/middleware/immer";

import type { LayoutNode, LeafNode } from "@/store/layout/tree";
import { leaf, leaves as treeLeaves } from "@/store/layout/tree";
import type { PaneId, Shell } from "@/types";
import { nextPaneId } from "@/lib/paneIds";
import { tauriPersistStorage } from "@/lib/persistStorage";
import { applyPaneIdRemap } from "@/store/paneResumeStore";
import {
  autoSuffixSessionName,
  basename,
  nextSessionName,
  samePath,
} from "@/lib/sessions/groupingHelpers";

export type SessionId = string;
export type SessionStatus = "active" | "stopped";
/** A durable side-by-side pairing of two sessions, as [leftId, rightId].
 *  Unlike splitView (transient view state), a SplitGroup PERSISTS: the sidebar
 *  renders the pair as one bracketed unit, and clicking either member re-opens
 *  the split — even after collapsing it, switching away, or restarting the app.
 *  A session belongs to at most one group (enforced on create + rehydrate). */
export type SplitGroup = [SessionId, SessionId];

export interface Session {
  id: SessionId;
  name: string;
  folderPath: string;
  layoutRoot: LayoutNode | null;
  focusedPaneId: PaneId | null;
  status: SessionStatus;
  unread: boolean;
  /** Transient "an agent/command is actively running here" signal (animated
   *  ring in the sidebar). Driven by the attentionTracker: OSC 133
   *  command-running for integrated shells, output cadence for the rest.
   *  Never persisted — coerced false on rehydrate, like unread. */
  working: boolean;
  gitBranch: string | null;
  fileTreeOpen: boolean;
  createdAt: number;
  lastActiveAt: number;
}

export interface SessionsState {
  sessions: Record<SessionId, Session>;
  activeSessionId: SessionId | null;
  // The session that was active when the app last had focus. Unlike
  // activeSessionId (always null on cold start), this PERSISTS so boot can
  // reopen it. Set on every activateSession; cleared if that session is purged.
  lastActiveSessionId: SessionId | null;
  // Every session that was RUNNING when the app last persisted (derived from
  // status at partialize time). Boot revives this whole fleet — the terminals
  // come back in their folders with their layouts; the processes themselves
  // can't survive a restart (DESIGN.md §1 invariant 5), so agents must be
  // relaunched inside them.
  lastRunningSessionIds: SessionId[];
  // User preference (persisted): reopen lastActiveSessionId on launch. Default
  // on. A Settings toggle can flip it later; for now it lives here.
  reopenLastSession: boolean;
  groupLabels: Record<string, string>;
  collapsedGroups: string[];
  // Two sessions shown side-by-side in the main area, as [leftId, rightId].
  // null = the normal single-session view. Transient view state, NEVER
  // persisted (like activeSessionId): a fresh launch is always single-view.
  // When set, activeSessionId is guaranteed to be one of the two members — it
  // marks which slot owns the keyboard (the focus ring); the slots themselves
  // keep their left/right position regardless of which is focused.
  splitView: [SessionId, SessionId] | null;
  // Durable side-by-side pairings (persisted). splitView is the split currently
  // SHOWN; splitGroups is the set of pairs REMEMBERED — they survive collapsing
  // the split, navigating away, and app restart. Formed by drag-to-split,
  // dissolved by ungroup or when a member is deleted.
  splitGroups: SplitGroup[];

  // Actions — implemented in subsequent tasks
  createSession: (folderPath: string, name?: string) => SessionId;
  activateSession: (id: SessionId) => void;
  stopSession: (id: SessionId) => void;
  purgeSession: (id: SessionId) => void;
  purgeGroup: (folderPath: string) => void;
  renameSession: (id: SessionId, name: string) => void;
  setGroupLabel: (folderPath: string, label: string) => void;
  toggleGroupCollapsed: (folderPath: string) => void;
  bumpUnread: (id: SessionId) => void;
  clearUnread: (id: SessionId) => void;
  setWorking: (id: SessionId, working: boolean) => void;
  updateBranch: (id: SessionId, branch: string | null) => void;
  setLayoutRoot: (id: SessionId, root: LayoutNode | null) => void;
  setFocusedPane: (id: SessionId, paneId: PaneId | null) => void;
  toggleFileTree: (id: SessionId) => void;
  /** Show `companionId` beside the active session (right slot), reviving it if
   *  stopped — WITHOUT stealing keyboard focus from the active (left) session.
   *  No-ops onto a single view if there's no active session or it's a self-drop. */
  openSplitWith: (companionId: SessionId) => void;
  /** Collapse the split AND unjoin the pair (the × on the seam). Dissolves the
   *  durable group so the two sessions return to standalone rows; the removed
   *  right session stays alive as a background session. (To leave the split but
   *  KEEP the pairing for later, just activate another session instead.) */
  closeSplit: () => void;
  /** Sidebar-click entry point. If `id` belongs to a durable split group, revive
   *  both members and re-open the split with the keyboard focus on the clicked
   *  member; otherwise behave exactly like activateSession. */
  enterSession: (id: SessionId) => void;
  /** Dissolve the durable group containing `id` (right-click → Ungroup). Both
   *  members return to standalone rows; collapses the split if it's on screen. */
  ungroupSession: (id: SessionId) => void;
  // Per-pane launch memory (Session restore — feature B). Both write onto the
  // matching leaf inside the session's layoutRoot, so they persist for free.
  setPaneShell: (id: SessionId, paneId: PaneId, shell: Shell) => void;
  setPaneStartupCommand: (id: SessionId, paneId: PaneId, command: string) => void;
  setReopenLastSession: (on: boolean) => void;
  /** Boot-time fleet revival: mark every id running again and focus
   *  `activeId` (falling back to the first revivable id). One store write →
   *  one orchestrator diff → all panes spawn. */
  resumeSessions: (ids: SessionId[], activeId: SessionId | null) => void;
  reset: () => void;
}

// Find the leaf for `paneId` within a layout tree (or null). Returns the live
// node so callers operating on an Immer draft can mutate it in place.
function findLeafNode(node: LayoutNode | null, paneId: PaneId): LeafNode | null {
  if (!node) return null;
  if (node.type === "leaf") return node.paneId === paneId ? node : null;
  return findLeafNode(node.left, paneId) ?? findLeafNode(node.right, paneId);
}

// Strictly-increasing creation stamp. Date.now() can return the same millisecond
// for two sessions created back-to-back, which would make createdAt an ambiguous
// sort key. Bumping by 1ms on a tie keeps it a TOTAL ordering — what the sidebar
// relies on for "newest session first within a folder" and "folders in fixed
// creation order". Module-scoped; resets each launch but new stamps always start
// at Date.now(), which is later than anything persisted from a prior run.
let lastCreatedAt = 0;
function nextCreatedAt(): number {
  const t = Date.now();
  lastCreatedAt = t > lastCreatedAt ? t : lastCreatedAt + 1;
  return lastCreatedAt;
}

const emptyState = () => ({
  sessions: {},
  activeSessionId: null,
  lastActiveSessionId: null,
  lastRunningSessionIds: [],
  reopenLastSession: true,
  groupLabels: {},
  collapsedGroups: [],
  splitView: null,
  splitGroups: [],
});

export const useSessionsStore = create<SessionsState>()(
  devtools(
    persist(
      immer((set, get) => ({
        ...emptyState(),
        createSession: (folderPath, name) => {
          const id = crypto.randomUUID();
          const now = nextCreatedAt();
          const siblingNames = Object.values(get().sessions)
            .filter((s) => samePath(s.folderPath, folderPath))
            .map((s) => s.name);
          // Default names are sequential per folder: "Session 1", "Session 2",
          // … (autoSuffix stays as a belt-and-suspenders collision guard for
          // explicitly-passed names).
          const desired = name ?? nextSessionName(siblingNames);
          const finalName = autoSuffixSessionName(desired, siblingNames);
          set((s) => {
            s.sessions[id] = {
              id,
              name: finalName,
              folderPath,
              layoutRoot: null,
              focusedPaneId: null,
              status: "stopped",
              unread: false,
              working: false,
              gitBranch: null,
              fileTreeOpen: false,
              createdAt: now,
              lastActiveAt: now,
            };
          });
          return id;
        },
        activateSession: (id) =>
          set((s) => {
            const session = s.sessions[id];
            if (!session) return;
            session.status = "active";
            session.unread = false;
            session.lastActiveAt = Date.now();
            s.activeSessionId = id;
            // Remember it for next launch (feature A — reopen last session).
            s.lastActiveSessionId = id;
            // Split coherence: focusing a member just moves the focus ring;
            // navigating to a session outside the pair collapses to single view.
            if (s.splitView && !s.splitView.includes(id)) s.splitView = null;
          }),

        stopSession: (id) =>
          set((s) => {
            const session = s.sessions[id];
            if (!session) return;
            session.status = "stopped";
            if (s.activeSessionId === id) s.activeSessionId = null;
            // A stopped session can't occupy a split slot — collapse the pair.
            if (s.splitView && s.splitView.includes(id)) s.splitView = null;
          }),

        purgeSession: (id) =>
          set((s) => {
            if (!s.sessions[id]) return;
            delete s.sessions[id];
            if (s.activeSessionId === id) s.activeSessionId = null;
            if (s.lastActiveSessionId === id) s.lastActiveSessionId = null;
            if (s.splitView && s.splitView.includes(id)) s.splitView = null;
            // A deleted session can't be half of a pair — dissolve its group.
            s.splitGroups = s.splitGroups.filter((g) => !g.includes(id));
          }),

        purgeGroup: (folderPath) =>
          set((s) => {
            for (const id of Object.keys(s.sessions)) {
              if (samePath(s.sessions[id].folderPath, folderPath)) {
                delete s.sessions[id];
                if (s.activeSessionId === id) s.activeSessionId = null;
                if (s.lastActiveSessionId === id) s.lastActiveSessionId = null;
                if (s.splitView && s.splitView.includes(id)) s.splitView = null;
              }
            }
            // Drop any group whose members no longer both exist.
            s.splitGroups = s.splitGroups.filter(
              (g) => s.sessions[g[0]] !== undefined && s.sessions[g[1]] !== undefined
            );
          }),

        renameSession: (id, name) =>
          set((s) => {
            const session = s.sessions[id];
            if (!session) return;
            if (name === "") {
              // Revert to the sequential default
              const siblings = Object.values(s.sessions)
                .filter((x) => x.id !== id && samePath(x.folderPath, session.folderPath))
                .map((x) => x.name);
              session.name = autoSuffixSessionName(nextSessionName(siblings), siblings);
            } else {
              session.name = name;
            }
          }),

        setGroupLabel: (folderPath, label) =>
          set((s) => {
            if (label === "") delete s.groupLabels[folderPath];
            else s.groupLabels[folderPath] = label;
          }),

        toggleGroupCollapsed: (folderPath) =>
          set((s) => {
            const idx = s.collapsedGroups.indexOf(folderPath);
            if (idx >= 0) s.collapsedGroups.splice(idx, 1);
            else s.collapsedGroups.push(folderPath);
          }),

        bumpUnread: (id) =>
          set((s) => {
            const session = s.sessions[id];
            if (!session) return;
            // Never light up the visible session — you're already looking at it.
            if (isSessionVisible(s, id)) return;
            session.unread = true;
          }),

        clearUnread: (id) =>
          set((s) => {
            const session = s.sessions[id];
            if (session) session.unread = false;
          }),

        setWorking: (id, working) =>
          set((s) => {
            const session = s.sessions[id];
            // Guard: the tracker calls this on transitions, but a same-value
            // write would still churn immer/persist for nothing.
            if (session && session.working !== working) session.working = working;
          }),

        updateBranch: (id, branch) =>
          set((s) => {
            const session = s.sessions[id];
            if (session) session.gitBranch = branch;
          }),

        setLayoutRoot: (id, root) =>
          set((s) => {
            const session = s.sessions[id];
            if (session) session.layoutRoot = root;
          }),

        setFocusedPane: (id, paneId) =>
          set((s) => {
            const session = s.sessions[id];
            if (session) session.focusedPaneId = paneId;
          }),

        toggleFileTree: (id) =>
          set((s) => {
            const session = s.sessions[id];
            if (session) session.fileTreeOpen = !session.fileTreeOpen;
          }),

        openSplitWith: (companionId) =>
          set((s) => {
            const comp = s.sessions[companionId];
            if (!comp) return;
            const active = s.activeSessionId;

            // Bring the companion onto the screen. Flipping status to "active"
            // is what makes MainArea mount it and the orchestrator spawn (or
            // revive) its PTYs — the same path as clicking it in the sidebar.
            // Seed a first pane for a brand-new session that was never opened,
            // mirroring App.tsx's bootstrap, so the slot isn't blank.
            comp.status = "active";
            comp.unread = false;
            comp.lastActiveAt = Date.now();
            if (comp.layoutRoot === null) {
              const pid = nextPaneId();
              comp.layoutRoot = leaf(pid);
              comp.focusedPaneId = pid;
            }

            // No left session to pair with (all-stopped), or a self-drop: there's
            // nothing to split against, so just open the companion full-screen.
            if (active === null || companionId === active) {
              s.activeSessionId = companionId;
              s.lastActiveSessionId = companionId;
              s.splitView = null;
              return;
            }

            // Pair them with the active session pinned to the left (keyboard
            // focus stays where it was); the companion takes the right slot. If
            // a split was already open, this replaces its right slot.
            s.splitView = [active, companionId];
            // Promote the pairing into a DURABLE group so it survives collapse +
            // restart. Drop any prior group either session was in (≤1 group per
            // session), then record the new pair in left/right order.
            s.splitGroups = s.splitGroups.filter(
              (g) => !g.includes(active) && !g.includes(companionId)
            );
            s.splitGroups.push([active, companionId]);
          }),

        closeSplit: () =>
          set((s) => {
            if (!s.splitView) return;
            const [left, right] = s.splitView;
            s.splitView = null;
            // The × unjoins the pair: drop the durable group so the two sessions
            // go back to standalone rows in the sidebar (the bracket disappears).
            // Leaving the split WITHOUT unjoining is the other path — activating
            // another session collapses the view but keeps the group.
            s.splitGroups = s.splitGroups.filter(
              (g) => !g.includes(left) && !g.includes(right)
            );
            // The × removes the right slot. If focus was on the right session,
            // hand it to the surviving left one so the keyboard target stays
            // visible. The removed session is NOT torn down — it lives on as a
            // background session (still streaming; its dot lights if it rings).
            if (s.activeSessionId === right) {
              const l = s.sessions[left];
              if (l) {
                l.status = "active";
                l.unread = false;
                l.lastActiveAt = Date.now();
                s.activeSessionId = left;
                s.lastActiveSessionId = left;
              }
            }
          }),

        enterSession: (id) =>
          set((s) => {
            const session = s.sessions[id];
            if (!session) return;
            const group = s.splitGroups.find((g) => g.includes(id)) ?? null;
            // Ungrouped (or a stale group whose other member vanished): plain
            // activate — same semantics as activateSession.
            if (!group || !s.sessions[group[0]] || !s.sessions[group[1]]) {
              if (group) s.splitGroups = s.splitGroups.filter((g) => g !== group);
              session.status = "active";
              session.unread = false;
              session.lastActiveAt = Date.now();
              s.activeSessionId = id;
              s.lastActiveSessionId = id;
              if (s.splitView && !s.splitView.includes(id)) s.splitView = null;
              return;
            }
            // Grouped: revive BOTH members (seeding a first pane for any that
            // was never opened, mirroring openSplitWith) and re-open the split.
            // Slots keep their stored left/right order; the clicked member just
            // takes the keyboard focus ring.
            for (const mid of group) {
              const m = s.sessions[mid];
              if (!m) continue;
              m.status = "active";
              m.unread = false;
              m.lastActiveAt = Date.now();
              if (m.layoutRoot === null) {
                const pid = nextPaneId();
                m.layoutRoot = leaf(pid);
                m.focusedPaneId = pid;
              }
            }
            s.splitView = [group[0], group[1]];
            s.activeSessionId = id;
            s.lastActiveSessionId = id;
          }),

        ungroupSession: (id) =>
          set((s) => {
            const before = s.splitGroups.length;
            s.splitGroups = s.splitGroups.filter((g) => !g.includes(id));
            if (s.splitGroups.length === before) return; // wasn't grouped
            // If the dissolved pair is the one currently on screen, collapse to
            // a single view (the focused member stays solo).
            if (s.splitView && s.splitView.includes(id)) s.splitView = null;
          }),

        setPaneShell: (id, paneId, shell) =>
          set((s) => {
            const session = s.sessions[id];
            if (!session) return;
            const node = findLeafNode(session.layoutRoot, paneId);
            if (node) node.shell = shell;
          }),

        setPaneStartupCommand: (id, paneId, command) =>
          set((s) => {
            const session = s.sessions[id];
            if (!session) return;
            const node = findLeafNode(session.layoutRoot, paneId);
            if (node) node.startupCommand = command;
          }),

        setReopenLastSession: (on) =>
          set((s) => {
            s.reopenLastSession = on;
          }),

        resumeSessions: (ids, activeId) =>
          set((s) => {
            for (const id of ids) {
              const sess = s.sessions[id];
              if (sess) sess.status = "active";
            }
            const focus =
              activeId && s.sessions[activeId] ? activeId : ids.find((id) => s.sessions[id]) ?? null;
            if (focus) {
              const sess = s.sessions[focus];
              sess.status = "active";
              sess.unread = false;
              sess.lastActiveAt = Date.now();
              s.activeSessionId = focus;
              s.lastActiveSessionId = focus;
            }
          }),

        reset: () =>
          set((s) => {
            s.sessions = {};
            s.activeSessionId = null;
            s.lastActiveSessionId = null;
            s.reopenLastSession = true;
            s.groupLabels = {};
            s.collapsedGroups = [];
            s.splitView = null;
            s.splitGroups = [];
          }),
      })),
      {
        name: "sessions",
        storage: createJSONStorage(() => tauriPersistStorage("lume-store.json")),
        version: 1,
        // Persist the durable per-session fields + grouping state. status and
        // unread are written as stopped/false (they're never meaningfully
        // persisted — see §11.1); activeSessionId is omitted entirely so cold
        // start is always all-stopped (spec §3). onRehydrateStorage re-coerces
        // defensively in case an older payload carried stale values.
        partialize: (state) => ({
          sessions: Object.fromEntries(
            Object.entries(state.sessions).map(([id, s]) => [
              id,
              {
                id: s.id,
                name: s.name,
                folderPath: s.folderPath,
                layoutRoot: s.layoutRoot,
                focusedPaneId: s.focusedPaneId,
                gitBranch: s.gitBranch,
                fileTreeOpen: s.fileTreeOpen,
                createdAt: s.createdAt,
                lastActiveAt: s.lastActiveAt,
                status: "stopped" as SessionStatus,
                unread: false,
                working: false,
              },
            ])
          ),
          groupLabels: state.groupLabels,
          collapsedGroups: state.collapsedGroups,
          // Durable split pairings survive restart (the sidebar shows them
          // bracketed; clicking re-opens the split). splitView itself stays
          // transient (omitted) so a cold start is always single-view.
          splitGroups: state.splitGroups,
          // Feature A: persisted so boot can reopen the last session. Unlike
          // activeSessionId (deliberately omitted → cold start is all-stopped),
          // these survive across launches.
          lastActiveSessionId: state.lastActiveSessionId,
          reopenLastSession: state.reopenLastSession,
          // Derived at persist time: the fleet that was running. Persist
          // writes happen on every mutation, so this is current as of the
          // last state change before exit.
          lastRunningSessionIds: Object.values(state.sessions)
            .filter((s) => s.status === "active")
            .map((s) => s.id),
        }),
        onRehydrateStorage: () => (state) => {
          if (!state) return;
          try {
            // Zustand's persist replaces state wholesale on rehydrate; apply the
            // coercion (status→stopped, unread→false, activeSessionId→null, drop
            // orphaned group entries) as a post-rehydrate cleanup.
            const coerced = coerceRehydrated(state);
            // Reassign all persisted paneIds to fresh globally-unique ones — the
            // counter resets each launch, so two sessions from different runs can
            // both hold "pane-101", which makes findSessionForPane resolve the
            // wrong session (e.g. spawning a terminal in the wrong folder).
            const paneIdRemap = remapSessionPaneIds(coerced.sessions ?? {});
            useSessionsStore.setState(coerced as SessionsState);
            // Plan 009: the resume store is keyed by paneId, so it must follow the
            // exact same remap or its records would orphan against the new ids.
            applyPaneIdRemap(paneIdRemap);
          } catch (err) {
            console.error("sessionsStore rehydrate failed; starting clean", err);
            useSessionsStore.setState(emptyState() as unknown as SessionsState);
          }
        },
      }
    ),
    { name: "sessionsStore" }
  )
);

// Pure coercion applied on rehydrate (and unit-tested directly). Enforces the
// §11 persistence contract: status is always "stopped" on launch, unread is
// cleared, activeSessionId is null (cold start = all-stopped), and group label
// / collapsed entries whose folderPath no longer has any session are dropped.
export function coerceRehydrated(state: Partial<SessionsState>): Partial<SessionsState> {
  const sessions: Record<string, Session> = {};
  for (const [id, s] of Object.entries(state.sessions ?? {})) {
    sessions[id] = { ...s, status: "stopped", unread: false, working: false } as Session;
  }
  // Migrate the pre-sequential-naming default: sessions persisted before
  // beta.4 were all created as "New session" and kept that name forever.
  // Christen them "Session N" per folder, oldest first, continuing from any
  // siblings already numbered (nextSessionName never reuses a number).
  const legacyNamed = Object.values(sessions)
    .filter((s) => s.name.trim().toLowerCase() === "new session")
    .sort((a, b) => a.createdAt - b.createdAt);
  for (const s of legacyNamed) {
    const siblings = Object.values(sessions)
      .filter((x) => x.id !== s.id && samePath(x.folderPath, s.folderPath))
      .map((x) => x.name);
    s.name = autoSuffixSessionName(nextSessionName(siblings), siblings);
  }
  const folderSet = new Set(Object.values(sessions).map((s) => s.folderPath));
  const groupLabels: Record<string, string> = {};
  for (const [path, label] of Object.entries(state.groupLabels ?? {})) {
    if (folderSet.has(path)) groupLabels[path] = label;
  }
  const collapsedGroups = (state.collapsedGroups ?? []).filter((p) => folderSet.has(p));
  // activeSessionId stays null (cold start = all-stopped). lastActiveSessionId
  // and the reopen preference survive so boot can decide whether to revive it;
  // drop a dangling lastActiveSessionId whose session no longer exists.
  const lastActiveSessionId =
    state.lastActiveSessionId && sessions[state.lastActiveSessionId]
      ? state.lastActiveSessionId
      : null;
  const reopenLastSession = state.reopenLastSession ?? true;
  // Drop revival ids whose session no longer exists (purged since persist).
  const lastRunningSessionIds = (state.lastRunningSessionIds ?? []).filter(
    (id) => sessions[id] !== undefined
  );
  // Durable split groups: keep only well-formed pairs whose BOTH members still
  // exist, distinct, and with each session in at most one group (first wins).
  const claimed = new Set<SessionId>();
  const splitGroups: SplitGroup[] = [];
  for (const g of state.splitGroups ?? []) {
    if (!Array.isArray(g) || g.length !== 2) continue;
    const [a, b] = g;
    if (a === b || !sessions[a] || !sessions[b]) continue;
    if (claimed.has(a) || claimed.has(b)) continue;
    claimed.add(a);
    claimed.add(b);
    splitGroups.push([a, b]);
  }
  return {
    sessions,
    activeSessionId: null,
    lastActiveSessionId,
    lastRunningSessionIds,
    reopenLastSession,
    groupLabels,
    collapsedGroups,
    // Split VIEW is transient — a fresh launch is always single-view — but the
    // durable GROUPS are restored so the sidebar shows the bracketed pairs.
    splitView: null,
    splitGroups,
  };
}

// Rebuild a layout tree with each paneId replaced via `mapper`.
function remapTreePaneIds(node: LayoutNode, mapper: (old: PaneId) => PaneId): LayoutNode {
  if (node.type === "leaf") return { ...node, paneId: mapper(node.paneId) };
  return {
    ...node,
    left: remapTreePaneIds(node.left, mapper),
    right: remapTreePaneIds(node.right, mapper),
  };
}

/**
 * Reassign every persisted session's paneIds to fresh, globally-unique ones.
 *
 * Why: the paneId counter (lib/paneIds) resets to a fixed base each launch and
 * is never reserved past persisted ids, so two sessions created in different
 * runs can both hold "pane-101". findSessionForPane then returns whichever is
 * first in iteration order — the wrong session — which surfaced as a terminal
 * spawning in the wrong folder (the cwd is resolved via the owning session).
 *
 * Remapping all panes through nextPaneId() in one pass on load guarantees
 * uniqueness within and across sessions, advances the counter past everything
 * in use (so mid-run new panes can't collide either), and self-heals
 * collisions already on disk. Safe because rehydrated sessions are all stopped
 * — no live PTY/Terminal references the old ids yet. Mutates in place; called
 * on the fresh session copies produced by coerceRehydrated.
 *
 * Returns the combined old→new mapping across all sessions so other paneId-keyed
 * persisted state (paneResumeStore) can follow the exact same remap.
 */
export function remapSessionPaneIds(
  sessions: Record<SessionId, Session>
): Record<PaneId, PaneId> {
  const combined: Record<PaneId, PaneId> = {};
  for (const session of Object.values(sessions)) {
    if (!session.layoutRoot) continue;
    const map = new Map<PaneId, PaneId>();
    const mapper = (old: PaneId): PaneId => {
      let next = map.get(old);
      if (next === undefined) {
        next = nextPaneId();
        map.set(old, next);
        combined[old] = next;
      }
      return next;
    };
    session.layoutRoot = remapTreePaneIds(session.layoutRoot, mapper);
    if (session.focusedPaneId !== null) {
      session.focusedPaneId = map.get(session.focusedPaneId) ?? null;
    }
  }
  return combined;
}

// ---------------------------------------------------------------------------
// Selectors (top-level pure functions over state — NOT store methods).
// Used by the sidebar renderer and the active-pane orchestrator.
// ---------------------------------------------------------------------------

export function sessionsForFolder(state: SessionsState, folderPath: string): Session[] {
  return Object.values(state.sessions)
    .filter((s) => samePath(s.folderPath, folderPath))
    .sort((a, b) => b.lastActiveAt - a.lastActiveAt);
}

export interface SessionGroupView {
  folderPath: string;
  label: string; // groupLabels[folderPath] ?? basename(folderPath)
  collapsed: boolean;
  sessions: Session[]; // sorted by createdAt desc (newest first)
}

// Accepts the minimal slice it reads (not the whole SessionsState) so callers
// can pass a memoized `{ sessions, groupLabels, collapsedGroups }` object built
// from individually-subscribed store slices. This matters because the result
// is a fresh array every call: subscribing to it directly via
// `useSessionsStore((s) => groupedSessions(s))` returns a new reference each
// render, which under Zustand v5 + useSyncExternalStore throws "getSnapshot
// should be cached" and crashes the app. Consumers must compute it in a
// useMemo over stable slices instead. Full SessionsState still satisfies the
// Pick, so getState() callers (keyboard shortcuts, tests) are unaffected.
export function groupedSessions(
  state: Pick<SessionsState, "sessions" | "groupLabels" | "collapsedGroups">
): SessionGroupView[] {
  // Bucket by exact folderPath (string identity, no normalization beyond
  // what's already stored). Same-folder dedup is handled by samePath where
  // it matters; this is the render-input grouping.
  //
  // Ordering is intentionally driven by createdAt, never lastActiveAt, so the
  // sidebar NEVER reshuffles when you click around:
  //   - sessions within a folder: newest first (createdAt desc)
  //   - folders: fixed creation order (newest first), keyed by the folder's
  //     earliest session — so a newly added project lands at the top, but the
  //     folder you used most recently never jumps around on click.
  // Cache each folder's earliest createdAt during the bucket loop so the
  // group-sort comparator stays O(n) and never spreads arrays.
  const byFolder: Record<string, Session[]> = {};
  const firstCreatedByFolder: Record<string, number> = {};
  for (const s of Object.values(state.sessions)) {
    (byFolder[s.folderPath] ??= []).push(s);
    const prev = firstCreatedByFolder[s.folderPath];
    if (prev === undefined || s.createdAt < prev) {
      firstCreatedByFolder[s.folderPath] = s.createdAt;
    }
  }
  const groups: SessionGroupView[] = Object.entries(byFolder).map(([folderPath, sessions]) => ({
    folderPath,
    label: state.groupLabels[folderPath] ?? basename(folderPath),
    collapsed: state.collapsedGroups.includes(folderPath),
    sessions: sessions.sort((a, b) => b.createdAt - a.createdAt),
  }));
  // Folders in fixed creation order, newest first (earliest-child createdAt
  // desc). Empty groups never exist by construction (a bucket is only created
  // on push), so firstCreatedByFolder is always populated for any folderPath.
  groups.sort(
    (a, b) => (firstCreatedByFolder[b.folderPath] ?? 0) - (firstCreatedByFolder[a.folderPath] ?? 0)
  );
  return groups;
}

/** The durable split group containing `id`, or null. Pure over the pairs list. */
export function groupOf(groups: SplitGroup[], id: SessionId): SplitGroup | null {
  for (const g of groups) if (g[0] === id || g[1] === id) return g;
  return null;
}

// A sidebar row is either a lone session or a bracketed split pair. The pair is
// anchored at the LEFT (primary) member's slot in its folder; the right member
// is drawn inside the bracket and omitted from wherever else it would list (its
// own folder included — so a cross-folder pair shows together under the left).
export type SidebarRow =
  | { kind: "single"; session: Session }
  | { kind: "pair"; left: Session; right: Session };

export interface SidebarFolderView {
  folderPath: string;
  label: string;
  collapsed: boolean;
  sessions: Session[]; // every session in this folder (for counts / add target)
  rows: SidebarRow[]; // render plan with split pairs bracketed
}

/**
 * The full sidebar render plan: folders (via groupedSessions) with durable split
 * pairs folded into bracketed rows. A pair renders once, at its left member's
 * position in the left member's folder; the right member is consumed there and
 * skipped everywhere else. Folders left with no rows (their only session was a
 * right-member shown under another folder) are dropped.
 */
export function planSidebar(
  state: Pick<SessionsState, "sessions" | "groupLabels" | "collapsedGroups" | "splitGroups">
): SidebarFolderView[] {
  const base = groupedSessions(state);
  // Index valid pairs (both members exist), enforcing ≤1 group per session.
  const pairByLeft = new Map<SessionId, SplitGroup>();
  const consumedRight = new Set<SessionId>();
  const claimed = new Set<SessionId>();
  for (const g of state.splitGroups) {
    const [l, r] = g;
    if (!state.sessions[l] || !state.sessions[r]) continue;
    if (claimed.has(l) || claimed.has(r)) continue;
    claimed.add(l);
    claimed.add(r);
    pairByLeft.set(l, g);
    consumedRight.add(r);
  }
  const out: SidebarFolderView[] = [];
  for (const folder of base) {
    const rows: SidebarRow[] = [];
    for (const s of folder.sessions) {
      if (consumedRight.has(s.id)) continue; // drawn inside its pair elsewhere
      const pair = pairByLeft.get(s.id);
      const right = pair ? state.sessions[pair[1]] : undefined;
      if (pair && right) rows.push({ kind: "pair", left: s, right });
      else rows.push({ kind: "single", session: s });
    }
    if (rows.length === 0) continue;
    out.push({
      folderPath: folder.folderPath,
      label: folder.label,
      collapsed: folder.collapsed,
      sessions: folder.sessions,
      rows,
    });
  }
  return out;
}

export function findSessionForPane(state: SessionsState, paneId: PaneId): Session | null {
  for (const s of Object.values(state.sessions)) {
    if (s.layoutRoot && treeLeaves(s.layoutRoot).includes(paneId)) return s;
  }
  return null;
}

export function getVisibleSessionIds(
  state: Pick<SessionsState, "splitView" | "activeSessionId">
): SessionId[] {
  if (state.splitView) return [...state.splitView];
  return state.activeSessionId ? [state.activeSessionId] : [];
}

export function isSessionVisible(
  state: Pick<SessionsState, "splitView" | "activeSessionId">,
  id: SessionId
): boolean {
  return getVisibleSessionIds(state).includes(id);
}

/** Union of paneIds across every active session. Used by the orchestrator. */
export function getActivePaneIds(state: SessionsState): PaneId[] {
  const out: PaneId[] = [];
  for (const s of Object.values(state.sessions)) {
    if (s.status !== "active" || !s.layoutRoot) continue;
    out.push(...treeLeaves(s.layoutRoot));
  }
  return out;
}

/** Union of paneIds that are ON SCREEN right now: the foreground session's
 *  panes, or both split-view members' panes when a split is open. Drives the
 *  render governor — only these panes render live + hold a WebGL context. */
export function getVisiblePaneIds(state: SessionsState): PaneId[] {
  const out: PaneId[] = [];
  for (const sid of getVisibleSessionIds(state)) {
    const root = state.sessions[sid]?.layoutRoot;
    if (root) out.push(...treeLeaves(root));
  }
  return out;
}

export interface PaneLaunchSpec {
  shell?: Shell;
  startupCommand?: string;
}

/**
 * The persisted launch memory for a pane: which shell it last ran and the
 * first command typed into it. The orchestrator reads this on (re)spawn to
 * revive the right shell and pre-fill the remembered command. Returns null if
 * the pane isn't found in any session's layout.
 */
export function paneLaunchSpec(state: SessionsState, paneId: PaneId): PaneLaunchSpec | null {
  for (const s of Object.values(state.sessions)) {
    const node = findLeafNode(s.layoutRoot, paneId);
    if (node) return { shell: node.shell, startupCommand: node.startupCommand };
  }
  return null;
}

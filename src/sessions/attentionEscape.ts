// attentionEscape — the OS-level attention loop for Plan 008's class-A signals
// (Plan 011). When a hooked agent enters `permission` (blocked) or `your-move`
// (turn complete), and Lume is minimized or the session is off-screen, the dot
// leaves the window: an OS toast, a taskbar flash, and a taskbar overlay badge
// carrying the fleet needs-you count.
//
// Design split (deliberate): `decideEscape` is a PURE function — given a single
// phase transition plus the current focus/visibility/prefs/gap, it returns what
// should escape (a toast? a flash?). Everything stateful — the store
// subscription, the per-pane previous-phase map, the cached window focus, the
// debounced badge writes, the last-toast timestamp — is thin wiring around it,
// so the whole policy is exhaustively unit-testable with no Tauri runtime.
//
// LOCKED RULES (operator, Plan 011):
//   - permission  → toast + flash + badge (the urgent one).
//   - your-move   → badge only; a toast ONLY with the opt-in pref.
//   - Master "OS notifications" toggle OFF → nothing escapes (incl. the badge:
//     the badge is an OS surface, so the master switch gates it too).
//   - Edge-triggered toasts/flash: fire on ENTERING a phase, never on staying.
//   - Suppressed when the window is focused AND the session is on-screen (the
//     in-window sidebar dot already covers that case).
//   - Global 3s min-gap between toasts; flash has no gap (the OS coalesces).
//   - The badge is NOT edge-triggered — it always mirrors the current count.

import { getCurrentWindow } from "@tauri-apps/api/window";

import { useAgentStore, type AgentName, type AgentPhase } from "@/store/agentStore";
import {
  useSessionsStore,
  findSessionForPane,
  isSessionVisible,
} from "@/store/sessionsStore";
import { usePrefsStore } from "@/store/prefsStore";
import { agentLabel, needsYouCounts } from "@/sessions/sessionSignal";
import {
  setNeedsYouBadge,
  flashTaskbar,
  sendToast,
  ensureNotificationPermission,
} from "@/lib/attentionClient";
import type { PaneId } from "@/types";

/** Global minimum gap between OS toasts (ms). A burst of blocks must not
 *  machine-gun the notification center. Flash is exempt — the OS coalesces. */
export const TOAST_MIN_GAP_MS = 3000;
/** Trailing debounce for badge writes — they cross IPC, and a rehydrate/revive
 *  can churn many phases in one tick. */
export const BADGE_DEBOUNCE_MS = 250;

export interface EscapeInput {
  transition: { paneId: PaneId; from: AgentPhase; to: AgentPhase };
  /** Which agent this pane runs (drives the toast title). */
  agent: AgentName;
  /** The signaling session's display name (the toast body). */
  sessionName: string;
  windowFocused: boolean;
  /** getVisibleSessionIds covers split view. */
  sessionVisible: boolean;
  prefs: { osNotifications: boolean; toastOnTurnComplete: boolean };
  now: number;
  lastToastAt: number;
}

export interface EscapeDecision {
  toast?: { title: string; body: string };
  flash: boolean;
}

const NOTHING: EscapeDecision = { flash: false };

/** Pure escape policy. See LOCKED RULES above. Returns what should escape for
 *  ONE transition; the caller performs the effects and advances `lastToastAt`
 *  only when a toast is actually returned. */
export function decideEscape(input: EscapeInput): EscapeDecision {
  // Master switch OFF → the window is sealed; nothing escapes.
  if (!input.prefs.osNotifications) return NOTHING;

  const { from, to } = input.transition;
  const enteringPermission = to === "permission" && from !== "permission";
  const enteringYourMove = to === "your-move" && from !== "your-move";
  // Only these two edges can ever escape; every other transition is silent.
  if (!enteringPermission && !enteringYourMove) return NOTHING;

  // You're already looking at it: focused AND the session on-screen. The
  // sidebar dot covers it, so don't double-notify. (Unfocused OR hidden → escape.)
  if (input.windowFocused && input.sessionVisible) return NOTHING;

  // Only a permission block flashes the taskbar; your-move is the calmer,
  // badge-only tier (a toast for it is the opt-in below).
  const flash = enteringPermission;

  // Toast: permission always; your-move only with the opt-in pref. Gated by the
  // 3s global min-gap (flash is not — it has no gap).
  const wantToast = enteringPermission || (enteringYourMove && input.prefs.toastOnTurnComplete);
  let toast: EscapeDecision["toast"];
  if (wantToast && input.now - input.lastToastAt >= TOAST_MIN_GAP_MS) {
    const who = agentLabel(input.agent);
    toast = enteringPermission
      ? { title: `⏸ ${who} needs permission`, body: input.sessionName }
      : { title: `✓ ${who} finished`, body: input.sessionName };
  }

  return toast ? { toast, flash } : { flash };
}

// ---------------------------------------------------------------------------
// Wiring (thin) — module-level state mirrors agentTracker's subscription style.
// ---------------------------------------------------------------------------

let prevPhases: Record<PaneId, AgentPhase> = {};
let windowFocused = true;
let lastToastAt = 0;
let badgeTimer: ReturnType<typeof setTimeout> | null = null;

/** The count the taskbar badge should currently show. Gated by the master
 *  toggle (OFF → 0/cleared) and uses the SAME selector as the StatusBar, so the
 *  chip and the badge can never disagree. */
function currentBadgeCount(): number {
  if (!usePrefsStore.getState().osNotifications) return 0;
  const s = useSessionsStore.getState();
  const c = needsYouCounts(useAgentStore.getState().panes, Object.values(s.sessions), s);
  return c.permission + c.yourMove;
}

/** Schedule a trailing-debounced badge write to the current truth. */
function scheduleBadge(): void {
  if (badgeTimer !== null) clearTimeout(badgeTimer);
  badgeTimer = setTimeout(() => {
    badgeTimer = null;
    void setNeedsYouBadge(currentBadgeCount());
  }, BADGE_DEBOUNCE_MS);
}

/** Handle one pane's phase transition: run the pure policy against live focus/
 *  visibility/prefs, then perform whatever it says should escape. */
function handleTransition(paneId: PaneId, from: AgentPhase, to: AgentPhase): void {
  const sess = findSessionForPane(useSessionsStore.getState(), paneId);
  if (!sess) return; // no owning session → nothing to name / no escape
  const agent = useAgentStore.getState().panes[paneId]?.agent ?? "claude";
  const decision = decideEscape({
    transition: { paneId, from, to },
    agent,
    sessionName: sess.name,
    windowFocused,
    sessionVisible: isSessionVisible(useSessionsStore.getState(), sess.id),
    prefs: {
      osNotifications: usePrefsStore.getState().osNotifications,
      toastOnTurnComplete: usePrefsStore.getState().toastOnTurnComplete,
    },
    now: Date.now(),
    lastToastAt,
  });
  if (decision.toast) {
    lastToastAt = Date.now();
    void sendToast(decision.toast.title, decision.toast.body);
  }
  if (decision.flash) void flashTaskbar();
}

/** Diff the agent store's phases against the previous snapshot, dispatch each
 *  changed pane through the policy, then refresh the badge. */
function onAgentStoreChange(): void {
  const panes = useAgentStore.getState().panes;
  const next: Record<PaneId, AgentPhase> = {};
  for (const [paneId, pa] of Object.entries(panes)) {
    next[paneId] = pa.phase;
    const prev = prevPhases[paneId];
    if (prev !== undefined && prev !== pa.phase) {
      handleTransition(paneId, prev, pa.phase);
    }
  }
  // Panes that vanished (SessionEnd) need no escape — just drop them.
  prevPhases = next;
  scheduleBadge();
}

/** Install the attention-escape loop. Call once at app boot; returns a
 *  disposer. Wiring failures are non-fatal — the in-window dot keeps working. */
export function installAttentionEscape(): () => void {
  // Reset module state so an HMR re-install never inherits stale focus/gap.
  windowFocused = true;
  lastToastAt = 0;
  if (badgeTimer !== null) {
    clearTimeout(badgeTimer);
    badgeTimer = null;
  }
  // Seed the phase snapshot from the current store so pre-existing panes don't
  // fire a spurious escape the instant we subscribe.
  prevPhases = {};
  for (const [paneId, pa] of Object.entries(useAgentStore.getState().panes)) {
    prevPhases[paneId] = pa.phase;
  }

  // Ask for notification permission once, up front.
  void ensureNotificationPermission();

  // Cache window focus (drives the suppression rule). Seed from isFocused();
  // track via the same focus/blur events branchPoller uses.
  void getCurrentWindow()
    .isFocused()
    .then((f) => {
      windowFocused = f;
    })
    .catch(() => {});
  let unlistenFocus: (() => void) | undefined;
  let unlistenBlur: (() => void) | undefined;
  void getCurrentWindow()
    .listen("tauri://focus", () => {
      windowFocused = true;
      // On focus gain the badge typically drops as the user acknowledges panes;
      // recompute so it can't lag behind (acknowledgment fires via agentStore).
      scheduleBadge();
    })
    .then((un) => {
      unlistenFocus = un;
    })
    .catch(() => {});
  void getCurrentWindow()
    .listen("tauri://blur", () => {
      windowFocused = false;
    })
    .then((un) => {
      unlistenBlur = un;
    })
    .catch(() => {});

  // Transitions + badge come from the agent store.
  const unsubAgents = useAgentStore.subscribe(onAgentStoreChange);
  // Visibility changes the badge count (visible sessions don't signal); the
  // master toggle gates the whole surface. Both feed the debounced badge.
  const unsubSessions = useSessionsStore.subscribe(scheduleBadge);
  const unsubPrefs = usePrefsStore.subscribe(scheduleBadge);

  // Seed the badge to the current truth.
  scheduleBadge();

  return () => {
    unsubAgents();
    unsubSessions();
    unsubPrefs();
    unlistenFocus?.();
    unlistenBlur?.();
    if (badgeTimer !== null) {
      clearTimeout(badgeTimer);
      badgeTimer = null;
    }
  };
}

/** Test/HMR reset — clears the module-level wiring state. */
export function disposeAttentionEscape(): void {
  prevPhases = {};
  windowFocused = true;
  lastToastAt = 0;
  if (badgeTimer !== null) {
    clearTimeout(badgeTimer);
    badgeTimer = null;
  }
}

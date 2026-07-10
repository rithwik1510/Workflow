// coachNav — the deliberate-navigation instrumentation seam for the workflow
// coach (Plan 014 §5). Metadata only: session ids, a source tag, and a
// timestamp — never content.
//
// The session-thrash detector (Step 4) must count DELIBERATE switches, not the
// raw activeSessionId churn (boot restore, programmatic activation, split-pair
// reopen, and clicks between already-visible split panes would all pollute it).
// So the coach never subscribes to activeSessionId; instead the two deliberate
// entry points — a sidebar row click and keyboard session cycling — call
// emitSessionNavigation, which drops the non-friction cases before forwarding.
//
// This module only records/forwards; the detector that consumes the stream
// lands in Step 4 and subscribes via onSessionNavigation. Master switch: while
// Workflow tips are OFF, noteSessionNavigation is a no-op (observation-off).

import { useSessionsStore, groupOf, type SessionId } from "@/store/sessionsStore";
import { usePrefsStore } from "@/store/prefsStore";
import { coachNow } from "@/store/coachStore";

export type NavigationSource = "sidebar" | "keyboard";

export interface SessionNavigation {
  /** The session left behind (null on the very first activation). */
  from: SessionId | null;
  to: SessionId;
  source: NavigationSource;
  /** Epoch ms (via the coach clock, so Step 4 tests stay deterministic). */
  at: number;
}

type NavListener = (nav: SessionNavigation) => void;
const listeners = new Set<NavListener>();

/** Subscribe to deliberate navigation events (Step 4 detector). Returns an
 *  unsubscribe. */
export function onSessionNavigation(fn: NavListener): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/**
 * Low-level seam: forward one deliberate navigation to subscribers. Master
 * switch — a no-op while Workflow tips are OFF, so no detector can observe or
 * accumulate anything while disabled (and re-enabling never replays).
 */
export function noteSessionNavigation(nav: SessionNavigation): void {
  if (!usePrefsStore.getState().tipsEnabled) return;
  for (const fn of listeners) fn(nav);
}

/**
 * Call from a deliberate navigation entry point (sidebar row click, keyboard
 * session cycling), BEFORE the store mutates. Suppresses the cases that are not
 * friction, then emits:
 *   - to === from            → not a move.
 *   - a split view is open   → both sessions are already on screen.
 *   - `to` reopens a durable split pair → that's a split-pair reopen, not a
 *     switch between two singles.
 * Programmatic activation and boot restore never call this at all.
 */
export function emitSessionNavigation(to: SessionId, source: NavigationSource): void {
  const s = useSessionsStore.getState();
  const from = s.activeSessionId;
  if (from === to) return;
  if (s.splitView !== null) return;
  const group = groupOf(s.splitGroups, to);
  if (group && s.sessions[group[0]] && s.sessions[group[1]]) return;
  noteSessionNavigation({ from, to, source, at: coachNow() });
}

/** Test-only: drop every subscriber. */
export function __resetCoachNav(): void {
  listeners.clear();
}

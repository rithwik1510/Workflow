// coachStore — persisted learning history + the gate engine for the workflow
// coach (Plan 014 §2–§3). This store is the ONE place the annoyance ceiling is
// enforced, so the Step 4 detectors get every gate for free: they only ever
// call recordEpisode / tryPush / shelve / graduate and never re-implement a
// threshold.
//
// Split of state (Plan 014 §2):
//   - PERSISTED (lume-coach.json): per-tip learning + the global push budget +
//     the shelf-dot bookkeeping. Days are LOCAL-calendar "YYYY-MM-DD" strings;
//     quietUntil / lastShelfDotAt are epoch ms.
//   - EPHEMERAL (never persisted): `activeTip` — what a live chip renders from.
//     It dies with the app; a restart is always chip-free.
//
// Master switch (Plan 014 §3 gate 1): while prefsStore.tipsEnabled is OFF the
// coach is OBSERVATION-off, not merely surface-off — recordEpisode / shelve /
// graduate / tryPush are all no-ops, and toggling off clears activeTip. Nothing
// that happened while off is replayed on re-enable.
//
// The engine reads time through an injected clock (`coachNow`) so time-dependent
// tests drive it without global fake timers.

import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import { immer } from "zustand/middleware/immer";

import { COACH_TUNING, TIP_CATALOG, type TipId } from "@/sessions/coachCatalog";
import { tauriPersistStorage } from "@/lib/persistStorage";
import { usePrefsStore } from "@/store/prefsStore";
import { useAgentStore } from "@/store/agentStore";
import type { PaneId } from "@/types";
import type { SessionId } from "@/store/sessionsStore";

// ---------------------------------------------------------------------------
// Injected clock + transient timing state (module-level — NONE of this belongs
// in Zustand: the input stamp is on the typing hot path, and the clock must be
// swappable in tests). Nothing here is ever persisted.
// ---------------------------------------------------------------------------

let coachClock: () => number = () => Date.now();

/** The engine's sole time source. Swap it in tests via __setCoachClock. */
export function coachNow(): number {
  return coachClock();
}

/** Test seam: replace the clock. */
export function __setCoachClock(fn: () => number): void {
  coachClock = fn;
}

/** Test seam: restore the real clock. */
export function __resetCoachClock(): void {
  coachClock = () => Date.now();
}

/** When the app (this module) started. Gate 5 blocks pushes in the first two
 *  minutes. Captured at load; overridable in tests so the warm-up gate is
 *  reachable under a fake clock. */
let appStartedAt = coachClock();

/** Test seam: pin the app-start moment for the warm-up gate. */
export function __setCoachAppStart(ms: number): void {
  appStartedAt = ms;
}

/** Epoch-ms of the most recent terminal keystroke. Written by noteTerminalInput
 *  on the typing hot path (a bare assignment — never a Zustand set()), read by
 *  gate 5. Global on purpose: the coach must not interrupt right after the user
 *  typed anywhere, not just in the anchored pane. */
let lastTerminalInputAt = 0;

/**
 * Record that the user just typed into a terminal (Plan 014 §5). METADATA ONLY
 * — a timestamp, never keys or content. Cheap by contract: this runs per
 * keystroke, so it is a single module-variable write and nothing else.
 * `paneId` is part of the seam for future per-pane timing; today the stamp is
 * global (see lastTerminalInputAt).
 */
export function noteTerminalInput(_paneId: PaneId, at: number = coachClock()): void {
  lastTerminalInputAt = at;
}

/** Read the last terminal-input stamp (gate 5 / tests). */
export function getLastTerminalInputAt(): number {
  return lastTerminalInputAt;
}

/** Test seam: clear the transient timing state. */
export function __resetCoachTiming(): void {
  lastTerminalInputAt = 0;
  appStartedAt = coachClock();
}

// Slot-free predicate (gate 6). The real check — "is the pane's top-center
// overlay slot free?" — is the shared pane-overlay arbitration helper built in
// Step 3; until it wires in, this defaults to "free". Injected so Step 3/4 and
// tests can supply the real predicate. Pane anchors only; the session-pair
// anchor has its own geometry and never consults this.
let paneSlotFree: (paneId: PaneId) => boolean = () => true;

/** Wire the real pane-overlay slot-free predicate (Step 3/4). */
export function setCoachPaneSlotFree(fn: (paneId: PaneId) => boolean): void {
  paneSlotFree = fn;
}

/** Test seam: restore the default (always-free) predicate. */
export function __resetCoachPaneSlotFree(): void {
  paneSlotFree = () => true;
}

// ---------------------------------------------------------------------------
// State shape
// ---------------------------------------------------------------------------

/** A live chip's render source — dies with the app (never persisted). */
export type CoachAnchor =
  | { kind: "pane"; paneId: PaneId }
  | { kind: "session-pair"; sessionIds: [SessionId, SessionId] };

export interface ActiveTip {
  tipId: TipId;
  anchor: CoachAnchor;
  /** Ephemeral display data (e.g. the observed pair's names) — kept OUT of the
   *  durable record so a shelf row never shows a stale name. */
  payload?: Record<string, string>;
  shownAt: number;
}

/** Per-tip learning record. Days are local "YYYY-MM-DD"; the *At fields are
 *  epoch ms. episodeDays is bounded to a trailing 14-day window. */
export interface TipRecord {
  shownCount: number;
  dismissedAt?: number;
  graduatedAt?: number;
  shelvedAt?: number;
  episodeDays: string[];
}

export interface CoachState {
  // Persisted
  tips: Record<string, TipRecord>;
  /** Local day-strings a push landed on, bounded to pushDatesBound entries. */
  pushDates: string[];
  /** Epoch ms until which NO push tip may fire (set by dismissForever). */
  quietUntil?: number;
  /** A shelf tip newly earned the ⌨ dot (cleared by markShelfOpened). */
  shelfHasNew: boolean;
  /** Epoch ms the shelf dot last lit — enforces the 7-day dot cooldown. */
  lastShelfDotAt?: number;

  // Ephemeral (never persisted)
  activeTip: ActiveTip | null;

  // Actions
  recordEpisode: (tipId: TipId) => number;
  tryPush: (tipId: TipId, anchor: CoachAnchor, payload?: Record<string, string>) => boolean;
  clearActiveTip: () => void;
  shelve: (tipId: TipId) => void;
  markShelfOpened: () => void;
  graduate: (tipId: TipId) => void;
  dismissForever: (tipId: TipId) => void;
  resetLearnedTips: () => void;
  reset: () => void;
}

// ---------------------------------------------------------------------------
// Local-calendar day helpers (exported for tests). Days are LOCAL, never UTC,
// so "one per calendar day" and the midnight boundaries match the user's clock.
// ---------------------------------------------------------------------------

export function localDay(ms: number): string {
  const d = new Date(ms);
  const y = d.getFullYear();
  const m = `${d.getMonth() + 1}`.padStart(2, "0");
  const day = `${d.getDate()}`.padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** Local midnight (ms) of a "YYYY-MM-DD" day-string. */
function dayToMidnight(day: string): number {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(y, m - 1, d).getTime();
}

/** Whole calendar days from `dayB` to `dayA` (rounded so a DST hour can't skew
 *  it). Positive when dayA is later. */
export function calendarDaysBetween(dayA: string, dayB: string): number {
  return Math.round((dayToMidnight(dayA) - dayToMidnight(dayB)) / 86_400_000);
}

/** Keep the most-recent `n` entries (chronological arrays append newest last). */
function boundTail<T>(arr: T[], n: number): T[] {
  return arr.length > n ? arr.slice(arr.length - n) : arr;
}

/** Pushes landing in the trailing weekly window, relative to `now`. */
function pushesInTrailingWindow(pushDates: string[], now: number): number {
  const today = localDay(now);
  let count = 0;
  for (const d of pushDates) {
    const diff = calendarDaysBetween(today, d);
    if (diff >= 0 && diff < COACH_TUNING.weeklyPushWindowDays) count += 1;
  }
  return count;
}

function ensureTip(tips: Record<string, TipRecord>, tipId: TipId): TipRecord {
  let rec = tips[tipId];
  if (!rec) {
    rec = { shownCount: 0, episodeDays: [] };
    tips[tipId] = rec;
  }
  return rec;
}

function tipsEnabled(): boolean {
  return usePrefsStore.getState().tipsEnabled;
}

/** Gate 5 helper: any hooked agent blocked on a permission prompt outranks the
 *  coach (the dot always wins). */
function anyPermissionBlocked(): boolean {
  const panes = useAgentStore.getState().panes;
  for (const id in panes) {
    if (panes[id].phase === "permission") return true;
  }
  return false;
}

const EMPTY: () => Pick<
  CoachState,
  "tips" | "pushDates" | "quietUntil" | "shelfHasNew" | "lastShelfDotAt" | "activeTip"
> = () => ({
  tips: {},
  pushDates: [],
  quietUntil: undefined,
  shelfHasNew: false,
  lastShelfDotAt: undefined,
  activeTip: null,
});

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export const useCoachStore = create<CoachState>()(
  persist(
    immer((set, get) => ({
      ...EMPTY(),

      // Record one distinct day of evidence for a tip (Step 4 detectors call
      // this and compare the returned distinct-day count to a threshold). No-op
      // while tips are off (observation-off) or the tip is already retired.
      recordEpisode: (tipId) => {
        if (!tipsEnabled()) return 0;
        const now = coachNow();
        const today = localDay(now);
        let count = 0;
        set((s) => {
          const r = ensureTip(s.tips, tipId);
          if (r.graduatedAt !== undefined || r.dismissedAt !== undefined) {
            count = r.episodeDays.length;
            return;
          }
          if (!r.episodeDays.includes(today)) r.episodeDays.push(today);
          // Trailing-window bound: drop days outside the 14-day window (this
          // also caps the array at ≤ 14 distinct entries).
          r.episodeDays = r.episodeDays.filter((d) => {
            const diff = calendarDaysBetween(today, d);
            return diff >= 0 && diff < COACH_TUNING.episodeWindowDays;
          });
          count = r.episodeDays.length;
        });
        return count;
      },

      // The gate engine (Plan 014 §3). Applies every gate in order; on success
      // it records the showing (shownCount + pushDates) and sets activeTip.
      // Returns whether the chip may show. Failures never retry (gate 6).
      tryPush: (tipId, anchor, payload) => {
        // Gate 1: master switch.
        if (!tipsEnabled()) return false;
        const def = TIP_CATALOG[tipId];
        // Only interrupt-lane tips push; a shelf tip can never reach a chip.
        if (!def || def.lane !== "push") return false;

        const now = coachNow();
        const s0 = get();
        const rec = s0.tips[tipId];

        // Gate 2: not graduated, not dismissed, under the lifetime cap.
        if (rec?.graduatedAt !== undefined) return false;
        if (rec?.dismissedAt !== undefined) return false;
        if ((rec?.shownCount ?? 0) >= def.lifetimeCap) return false;

        // Gate 3: global quiet after an explicit dismissal.
        if (s0.quietUntil !== undefined && now < s0.quietUntil) return false;

        // Gate 4: budget — no push yet this calendar day, AND the trailing-7-day
        // window would still hold ≤ 2 after this one. (The plan's "≤ 2 pushes in
        // the trailing 7 days" is the post-push invariant "at most two in any
        // trailing 7 days"; we admit only when the existing count is < the cap.)
        const today = localDay(now);
        if (s0.pushDates.includes(today)) return false;
        if (pushesInTrailingWindow(s0.pushDates, now) >= COACH_TUNING.weeklyPushCap) return false;

        // Gate 5: timing seam.
        if (now - lastTerminalInputAt < COACH_TUNING.terminalInputQuietMs) return false;
        if (anyPermissionBlocked()) return false;
        if (now - appStartedAt < COACH_TUNING.appWarmupMs) return false;

        // Gate 6: slot free (pane anchors only) — the coach is the lowest-priority
        // occupant of the pane's top-center slot; if it's taken it simply doesn't
        // show and does NOT retry. The session-pair anchor has its own geometry.
        if (anchor.kind === "pane" && !paneSlotFree(anchor.paneId)) return false;

        set((s) => {
          const r = ensureTip(s.tips, tipId);
          r.shownCount += 1;
          s.pushDates = boundTail([...s.pushDates, today], COACH_TUNING.pushDatesBound);
          s.activeTip = { tipId, anchor, payload, shownAt: now };
        });
        return true;
      },

      clearActiveTip: () =>
        set((s) => {
          s.activeTip = null;
        }),

      // Preserve a tip on the "For you" shelf (Plan 014 §7). No-op while off or
      // once the tip is retired. Lights the ⌨ dot only on a tip's FIRST shelving
      // and at most once per 7-day cooldown (lastShelfDotAt).
      shelve: (tipId) => {
        if (!tipsEnabled()) return;
        if (!TIP_CATALOG[tipId]) return;
        const now = coachNow();
        set((s) => {
          const r = ensureTip(s.tips, tipId);
          if (r.graduatedAt !== undefined || r.dismissedAt !== undefined) return;
          const firstShelving = r.shelvedAt === undefined;
          if (firstShelving) r.shelvedAt = now;
          const dotFree =
            s.lastShelfDotAt === undefined ||
            now - s.lastShelfDotAt >= COACH_TUNING.shelfDotCooldownMs;
          if (firstShelving && dotFree) {
            s.shelfHasNew = true;
            s.lastShelfDotAt = now;
          }
        });
      },

      // The shortcuts/tips modal opened — clear the ⌨ dot (Plan 014 §7). Not
      // guarded: opening the modal always clears any pending dot.
      markShelfOpened: () =>
        set((s) => {
          s.shelfHasNew = false;
        }),

      // Retire a tip permanently — the user performed the taught action (Plan
      // 014 §2). Idempotent; also drops a live chip for the tip. Observation-off
      // while tips are disabled (the detectors that call this are off anyway).
      graduate: (tipId) => {
        if (!tipsEnabled()) return;
        if (!TIP_CATALOG[tipId]) return;
        const now = coachNow();
        set((s) => {
          const r = ensureTip(s.tips, tipId);
          if (r.graduatedAt === undefined) r.graduatedAt = now;
          if (s.activeTip?.tipId === tipId) s.activeTip = null;
        });
      },

      // "Don't suggest this" (Plan 014 §3 gate 3 / §7). Explicit dismissal is
      // feedback about the whole SYSTEM: dismissing any PUSH tip opens a 7-day
      // global quiet window. Always honored (it can only be reached from a live
      // chip, which requires tips on).
      dismissForever: (tipId) => {
        const def = TIP_CATALOG[tipId];
        if (!def) return;
        const now = coachNow();
        set((s) => {
          const r = ensureTip(s.tips, tipId);
          if (r.dismissedAt === undefined) r.dismissedAt = now;
          if (def.lane === "push") s.quietUntil = now + COACH_TUNING.dismissQuietMs;
          if (s.activeTip?.tipId === tipId) s.activeTip = null;
        });
      },

      // "Reset learned tips" (Plan 014 §2). Clears all learning + notice history
      // + the live chip, but leaves the user's tipsEnabled preference (which
      // lives in prefsStore) untouched by construction.
      resetLearnedTips: () =>
        set((s) => {
          Object.assign(s, EMPTY());
        }),

      reset: () =>
        set((s) => {
          Object.assign(s, EMPTY());
        }),
    })),
    {
      name: "coach",
      storage: createJSONStorage(() => tauriPersistStorage("lume-coach.json")),
      version: 1,
      // activeTip + all module-level timing state are EPHEMERAL and excluded.
      partialize: (state) => ({
        tips: state.tips,
        pushDates: state.pushDates,
        quietUntil: state.quietUntil,
        shelfHasNew: state.shelfHasNew,
        lastShelfDotAt: state.lastShelfDotAt,
      }),
      onRehydrateStorage: () => (state) => {
        if (!state) return;
        useCoachStore.setState(coerceCoachRehydrated(state));
      },
    }
  )
);

/**
 * Pure rehydrate coercion (exported for tests): re-bound the persisted arrays,
 * coerce shapes defensively, and guarantee activeTip is null (it is ephemeral
 * and must never come back from disk). Mirrors sessionsStore.coerceRehydrated.
 */
export function coerceCoachRehydrated(state: Partial<CoachState>): Partial<CoachState> {
  const tips: Record<string, TipRecord> = {};
  for (const [id, rec] of Object.entries(state.tips ?? {})) {
    if (!rec) continue;
    const days = Array.isArray(rec.episodeDays) ? rec.episodeDays : [];
    tips[id] = {
      shownCount: rec.shownCount ?? 0,
      dismissedAt: rec.dismissedAt,
      graduatedAt: rec.graduatedAt,
      shelvedAt: rec.shelvedAt,
      episodeDays: boundTail(days, COACH_TUNING.episodeWindowDays),
    };
  }
  return {
    tips,
    pushDates: boundTail(
      Array.isArray(state.pushDates) ? state.pushDates : [],
      COACH_TUNING.pushDatesBound
    ),
    quietUntil: state.quietUntil,
    shelfHasNew: state.shelfHasNew ?? false,
    lastShelfDotAt: state.lastShelfDotAt,
    activeTip: null,
  };
}

// Master switch is OBSERVATION-off: toggling Workflow tips OFF also clears any
// live chip (Plan 014 §2). Recording/shelving/graduating already guard on
// tipsEnabled inside each action; this covers the one piece of state those
// guards can't reach — the chip already on screen.
usePrefsStore.subscribe((s, prev) => {
  if (prev.tipsEnabled && !s.tipsEnabled) {
    useCoachStore.getState().clearActiveTip();
  }
});

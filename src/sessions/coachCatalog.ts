// coachCatalog — the declarative source of truth for the workflow coach
// (Plan 014 §1). One TIP_CATALOG entry per tip + one COACH_TUNING object for
// every numeric threshold. Adding tip #5 later = one catalog entry + one
// detector; no engine change. Copy strings are load-bearing product voice
// (video-caption rules: declarative, no adjectives) — treat them as verbatim.

/** The Phase A tips. New ids are added here and nowhere else. */
export type TipId = "selection-rescue" | "session-thrash" | "precise-signals" | "scroll-hunt";

/** push = the interrupt lane (a live chip); shelf = the pull lane (a "For you"
 *  row in the Ctrl+? modal, zero interruption). */
export type TipLane = "push" | "shelf";

/** How a live chip anchors when a push tip fires. Shelf-only tips never push,
 *  so they anchor to nothing. */
export type AnchorKind = "pane" | "session-pair" | "none";

export interface TipDef {
  tipId: TipId;
  lane: TipLane;
  /** Primary copy: the live chip line (push) or the shelf row line (shelf).
   *  ≤ 10 words, declarative. Verbatim from the plan where the plan gives it. */
  copy: string;
  /** Generic durable shelf copy for a PUSH tip that is ALSO preserved on the
   *  shelf after firing (session thrash): the contextual chip names the pair,
   *  the durable row must stay generic. Absent for tips whose shelf line, if
   *  any, is just `copy`. */
  shelfCopy?: string;
  /** Keycap chips rendered with the tip, in order (e.g. ["Ctrl", "F"]). */
  keycaps?: string[];
  /** Max lifetime PUSH showings (gate 2). Nominal for shelf-only tips — they
   *  never reach tryPush, so the cap is unused for them. */
  lifetimeCap: number;
  /** The anchor a live chip uses when this tip pushes. */
  anchorKind: AnchorKind;
  /** Human description of the graduation signal — the taught action that
   *  retires the tip permanently (including retroactively). Documentation for
   *  the Step 4 detectors; not rendered. */
  graduation: string;
}

export const TIP_CATALOG: Record<TipId, TipDef> = {
  // Interrupt lane — active failure. A drag-to-select inside a mouse-reporting
  // TUI selects nothing; the user then presses Ctrl+Shift+C on the empty
  // selection (explicit proof they believe something is selected).
  "selection-rescue": {
    tipId: "selection-rescue",
    lane: "push",
    copy: "Hold Shift while dragging to select inside this TUI.",
    keycaps: ["Shift"],
    lifetimeCap: 2,
    anchorKind: "pane",
    graduation: "First successful Shift+drag selection in any mouse-reporting pane.",
  },

  // Interrupt lane — high-confidence friction. ≥ 6 deliberate switches between
  // the same two sessions within 10 minutes. Pushes once with the pair named
  // in the ephemeral payload; the durable shelf row stays generic (shelfCopy).
  "session-thrash": {
    tipId: "session-thrash",
    lane: "push",
    copy: "Keep these together — drag one onto the other to split.",
    shelfCopy: "Drag one session onto another to keep them side by side.",
    lifetimeCap: 1,
    anchorKind: "session-pair",
    graduation: "A durable split group exists, or a drag-to-split succeeds.",
  },

  // Shelf lane — promotion, never a push. A claude pane stays command-identified
  // with no hook events for 30s and hooks-status confirms hooks are absent.
  "precise-signals": {
    tipId: "precise-signals",
    lane: "shelf",
    copy: "Claude detected — enable Precise Claude Code signals for exact permission & turn states (Settings → Agents).",
    lifetimeCap: 1,
    anchorKind: "none",
    graduation: "Any Claude hook event arrives, or hooks-status reports installed.",
  },

  // Shelf lane — scroll-hunting past the viewport with no search opened, on two
  // distinct days.
  "scroll-hunt": {
    tipId: "scroll-hunt",
    lane: "shelf",
    copy: "Press Ctrl+F to search this terminal's scrollback.",
    keycaps: ["Ctrl", "F"],
    lifetimeCap: 1,
    anchorKind: "none",
    graduation: "Terminal search (Ctrl+F) is opened.",
  },
};

/** Every numeric knob the coach uses, in one place (Plan 014 §1). The gate
 *  engine (Step 1) reads the budget/timing/window values; the detectors
 *  (Step 4) read the per-detector thresholds. Times are in ms unless the name
 *  says days/px. */
export const COACH_TUNING = {
  // --- Gate 5: timing seam ---
  /** A push is blocked within this window of the last terminal keystroke. */
  terminalInputQuietMs: 2000,
  /** No push in the app's first two minutes (boot noise / settling). */
  appWarmupMs: 120_000,

  // --- Gate 3: global quiet after an explicit dismissal ---
  /** dismissForever on any push tip silences EVERY push for this long. */
  dismissQuietMs: 7 * 24 * 60 * 60 * 1000,

  // --- Gate 4: push budget (one rule, no exemptions) ---
  /** Trailing window for the weekly cap. */
  weeklyPushWindowDays: 7,
  /** At most this many pushes may land in any trailing 7-day window. */
  weeklyPushCap: 2,

  // --- Persisted array bounds ---
  /** pushDates keeps at most this many entries (≈ 7 distinct days). */
  pushDatesBound: 7,
  /** episodeDays is bounded to this trailing day-window per tip. */
  episodeWindowDays: 14,

  // --- Shelf notification dot ---
  /** The ⌨ top-bar dot lights at most once per this window (lastShelfDotAt). */
  shelfDotCooldownMs: 7 * 24 * 60 * 60 * 1000,

  // --- Live chip (Step 3) ---
  /** A live chip auto-fades ("not now") after this long. */
  autoFadeMs: 8000,

  // --- Detector thresholds (Step 4) ---
  /** Session thrash: alternations between the same pair to fire. */
  thrashSwitches: 6,
  /** Session thrash: within this window. */
  thrashWindowMs: 10 * 60 * 1000,
  /** Selection rescue: minimum drag travel (px) to count as a select attempt. */
  selectionDragMinPx: 24,
  /** Selection rescue: Ctrl+Shift+C must follow the failed drag within this. */
  selectionCopyWindowMs: 4000,
  /** Precise signals: a claude/command pane must persist this long before we
   *  call hooks-status once. */
  preciseSignalsArmMs: 30_000,
  /** Scroll hunt: viewport this many lines above the bottom counts as hunting. */
  scrollHuntMinLinesFromBottom: 300,
  /** Scroll hunt: dwell this long at that height for one episode. */
  scrollHuntDwellMs: 10_000,
  /** Scroll hunt: episodes needed within a single app run. */
  scrollHuntEpisodesPerRun: 2,
  /** Scroll hunt: distinct days of episodes needed to shelve. */
  scrollHuntDistinctDays: 2,
} as const;

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// persist middleware pulls in plugin-store on import; stub it so no Tauri
// runtime is needed and NO real user config is ever touched.
vi.mock("@tauri-apps/plugin-store", () => ({
  load: vi.fn(async () => ({
    get: vi.fn(async () => null),
    set: vi.fn(async () => undefined),
    delete: vi.fn(async () => undefined),
  })),
}));

// registry pulls in xterm + addons; the detectors under test never touch it, so
// stub the two seams initCoach wires. (The per-terminal listener wiring is
// exercised indirectly through the detector factories with synthetic events.)
vi.mock("@/terminals/registry", () => ({
  setCoachTerminalObserver: vi.fn(),
  setCoachEmptyShiftCopy: vi.fn(),
}));

// Precise-signals probes the on-disk hooks status once; the test controls it.
const hooksStatus = vi.fn(async () => false);
vi.mock("@/lib/claudeHooksClient", () => ({
  claudeHooksStatus: () => hooksStatus(),
}));

import {
  createSelectionRescueDetector,
  createThrashDetector,
  createPreciseSignalsDetector,
  createScrollHuntDetector,
  noteDragSplitCreated,
  initCoach,
  disposeCoach,
} from "@/sessions/coach";
import {
  useCoachStore,
  __setCoachClock,
  __resetCoachClock,
  __resetCoachTiming,
  __setCoachAppStart,
  __resetCoachPaneSlotFree,
} from "@/store/coachStore";
import { usePrefsStore } from "@/store/prefsStore";
import { useAgentStore } from "@/store/agentStore";
import { useSessionsStore, type SessionId } from "@/store/sessionsStore";
import { emitSessionNavigation, __resetCoachNav } from "@/sessions/coachNav";
import { COACH_TUNING } from "@/sessions/coachCatalog";
import type { PaneId } from "@/types";
import type { SessionNavigation } from "@/sessions/coachNav";

const P = "p1" as PaneId;
const BASE = new Date(2026, 5, 10, 12, 0, 0).getTime();
const DAY = 24 * 60 * 60 * 1000;
let now = BASE;

function primeGates(): void {
  now = BASE;
  __setCoachClock(() => now);
  __resetCoachTiming();
  __setCoachAppStart(BASE - COACH_TUNING.appWarmupMs - 1000);
}

function nav(from: SessionId | null, to: SessionId, at: number): SessionNavigation {
  return { from, to, source: "sidebar", at };
}

beforeEach(() => {
  useCoachStore.getState().reset();
  usePrefsStore.getState().reset();
  useAgentStore.getState().reset();
  useSessionsStore.getState().reset();
  __resetCoachNav();
  __resetCoachClock();
  __resetCoachPaneSlotFree();
  hooksStatus.mockReset();
  hooksStatus.mockResolvedValue(false);
  primeGates();
});

// ---------------------------------------------------------------------------
// Detector 1 — failed TUI selection
// ---------------------------------------------------------------------------

describe("coach — selection rescue", () => {
  function failedDrag(d = createSelectionRescueDetector()) {
    d.onPointerDown(P, 100, 100, false);
    d.onPointerUp(P, 140, 100, false, /*mouseReporting*/ true, /*hasSelection*/ false);
    return d;
  }

  it("failed drag + Ctrl+Shift+C on empty selection pushes", () => {
    const d = failedDrag();
    d.onEmptyShiftCopy(P);
    const tip = useCoachStore.getState().activeTip;
    expect(tip?.tipId).toBe("selection-rescue");
    expect(tip?.anchor).toEqual({ kind: "pane", paneId: P });
    expect(useCoachStore.getState().tips["selection-rescue"].shownCount).toBe(1);
  });

  it("a failed drag WITHOUT the copy attempt never fires (vim false positive)", () => {
    failedDrag();
    // No onEmptyShiftCopy — a plain drag inside vim must stay silent.
    expect(useCoachStore.getState().activeTip).toBeNull();
  });

  it("an empty Ctrl+Shift+C with NO preceding failed drag does nothing", () => {
    const d = createSelectionRescueDetector();
    d.onEmptyShiftCopy(P);
    expect(useCoachStore.getState().activeTip).toBeNull();
  });

  it("the copy must land within the 4s window", () => {
    const d = failedDrag();
    now = BASE + COACH_TUNING.selectionCopyWindowMs + 1;
    d.onEmptyShiftCopy(P);
    expect(useCoachStore.getState().activeTip).toBeNull();
  });

  it("Shift held at pointer-down is not a failed plain drag", () => {
    const d = createSelectionRescueDetector();
    d.onPointerDown(P, 100, 100, true); // shift down
    d.onPointerUp(P, 140, 100, false, true, false);
    d.onEmptyShiftCopy(P);
    expect(useCoachStore.getState().activeTip).toBeNull();
  });

  it("a sub-threshold drag is not evidence", () => {
    const d = createSelectionRescueDetector();
    d.onPointerDown(P, 100, 100, false);
    d.onPointerUp(P, 110, 100, false, true, false); // 10px < 24px
    d.onEmptyShiftCopy(P);
    expect(useCoachStore.getState().activeTip).toBeNull();
  });

  it("a drag outside a mouse-reporting TUI is not evidence", () => {
    const d = createSelectionRescueDetector();
    d.onPointerDown(P, 100, 100, false);
    d.onPointerUp(P, 140, 100, false, /*mouseReporting*/ false, false);
    d.onEmptyShiftCopy(P);
    expect(useCoachStore.getState().activeTip).toBeNull();
  });

  it("a successful Shift+drag selection graduates and blocks future pushes", () => {
    const d = createSelectionRescueDetector();
    d.onPointerDown(P, 100, 100, true);
    d.onPointerUp(P, 140, 100, true, /*mouseReporting*/ true, /*hasSelection*/ true);
    expect(useCoachStore.getState().tips["selection-rescue"].graduatedAt).toBeDefined();
    // A later failed drag + copy can no longer push.
    d.onPointerDown(P, 100, 100, false);
    d.onPointerUp(P, 140, 100, false, true, false);
    d.onEmptyShiftCopy(P);
    expect(useCoachStore.getState().activeTip).toBeNull();
  });

  it("records nothing while tips are off", () => {
    usePrefsStore.getState().setTipsEnabled(false);
    const d = failedDrag();
    d.onEmptyShiftCopy(P);
    expect(useCoachStore.getState().activeTip).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Detector 2 — session thrash
// ---------------------------------------------------------------------------

describe("coach — session thrash", () => {
  it("6 alternations between the same pair pushes then shelves", () => {
    const d = createThrashDetector();
    const seq: [SessionId, SessionId][] = [
      ["a", "b"],
      ["b", "a"],
      ["a", "b"],
      ["b", "a"],
      ["a", "b"],
      ["b", "a"],
    ];
    seq.forEach(([from, to], i) => d.onNavigation(nav(from, to, BASE + i * 1000)));
    const tip = useCoachStore.getState().activeTip;
    expect(tip?.tipId).toBe("session-thrash");
    expect(tip?.anchor.kind).toBe("session-pair");
    // Shelved regardless of push outcome.
    expect(useCoachStore.getState().tips["session-thrash"].shelvedAt).toBeDefined();
  });

  it("a third session breaks the streak", () => {
    const d = createThrashDetector();
    // Five AB switches, then AC resets the pair, then AB again — never 6 in a row.
    d.onNavigation(nav("a", "b", BASE));
    d.onNavigation(nav("b", "a", BASE + 1000));
    d.onNavigation(nav("a", "b", BASE + 2000));
    d.onNavigation(nav("b", "a", BASE + 3000));
    d.onNavigation(nav("a", "b", BASE + 4000));
    d.onNavigation(nav("b", "c", BASE + 5000)); // resets to pair {b,c}
    d.onNavigation(nav("c", "b", BASE + 6000));
    d.onNavigation(nav("b", "a", BASE + 7000)); // resets to {a,b}
    expect(useCoachStore.getState().activeTip).toBeNull();
  });

  it("switches spread beyond the 10-minute window don't accumulate", () => {
    const d = createThrashDetector();
    for (let i = 0; i < 6; i++) {
      d.onNavigation(nav(i % 2 ? "a" : "b", i % 2 ? "b" : "a", BASE + i * (3 * 60 * 1000)));
    }
    // 6 switches but 3min apart → the window only ever holds a few at once.
    expect(useCoachStore.getState().activeTip).toBeNull();
  });

  it("names the observed pair in the ephemeral payload only", () => {
    const a = useSessionsStore.getState().createSession("C:/proj");
    const b = useSessionsStore.getState().createSession("C:/proj");
    useSessionsStore.getState().renameSession(a, "web");
    useSessionsStore.getState().renameSession(b, "api");
    const d = createThrashDetector();
    for (let i = 0; i < 6; i++) {
      d.onNavigation(nav(i % 2 ? a : b, i % 2 ? b : a, BASE + i * 1000));
    }
    const tip = useCoachStore.getState().activeTip;
    expect(tip?.payload).toBeDefined();
    expect(Object.values(tip!.payload!)).toEqual(expect.arrayContaining(["web", "api"]));
    // The durable shelf record carries NO names (generic copy only).
    expect(useCoachStore.getState().tips["session-thrash"]).not.toHaveProperty("payload");
  });

  it("noteDragSplitCreated graduates the tip", () => {
    noteDragSplitCreated();
    expect(useCoachStore.getState().tips["session-thrash"].graduatedAt).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Detector 3 — precise signals
// ---------------------------------------------------------------------------

describe("coach — precise signals", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function claudeCommandPane(paneId = "pc" as PaneId) {
    useAgentStore.getState().setPaneAgent(paneId, {
      agent: "claude",
      phase: "idle",
      source: "command",
    });
  }

  it("shelves (once) when a claude/command pane sustains 30s and hooks are absent", async () => {
    hooksStatus.mockResolvedValue(false);
    const d = createPreciseSignalsDetector();
    claudeCommandPane();
    d.evaluate();
    await vi.advanceTimersByTimeAsync(COACH_TUNING.preciseSignalsArmMs);
    expect(hooksStatus).toHaveBeenCalledTimes(1);
    expect(useCoachStore.getState().tips["precise-signals"].shelvedAt).toBeDefined();
  });

  it("graduates (suppresses) when hooks-status reports installed", async () => {
    hooksStatus.mockResolvedValue(true);
    const d = createPreciseSignalsDetector();
    claudeCommandPane();
    d.evaluate();
    await vi.advanceTimersByTimeAsync(COACH_TUNING.preciseSignalsArmMs);
    expect(useCoachStore.getState().tips["precise-signals"].graduatedAt).toBeDefined();
    expect(useCoachStore.getState().tips["precise-signals"].shelvedAt).toBeUndefined();
  });

  it("a hook event during the arm window graduates immediately (no status call)", async () => {
    const d = createPreciseSignalsDetector();
    claudeCommandPane();
    d.evaluate();
    // A hook arrives before 30s: canary flips → evaluate → graduate.
    useAgentStore.getState().markSessionStart();
    d.evaluate();
    await vi.advanceTimersByTimeAsync(COACH_TUNING.preciseSignalsArmMs);
    expect(useCoachStore.getState().tips["precise-signals"].graduatedAt).toBeDefined();
    expect(hooksStatus).not.toHaveBeenCalled();
  });

  it("probes hooks-status at most once across multiple claude/command panes", async () => {
    hooksStatus.mockResolvedValue(false);
    const d = createPreciseSignalsDetector();
    claudeCommandPane("pc1" as PaneId);
    claudeCommandPane("pc2" as PaneId);
    d.evaluate();
    await vi.advanceTimersByTimeAsync(COACH_TUNING.preciseSignalsArmMs);
    expect(hooksStatus).toHaveBeenCalledTimes(1);
  });

  it("does not arm while tips are off", async () => {
    usePrefsStore.getState().setTipsEnabled(false);
    const d = createPreciseSignalsDetector();
    claudeCommandPane();
    d.evaluate();
    await vi.advanceTimersByTimeAsync(COACH_TUNING.preciseSignalsArmMs);
    expect(hooksStatus).not.toHaveBeenCalled();
    expect(useCoachStore.getState().tips["precise-signals"]).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Detector 4 — scroll hunt
// ---------------------------------------------------------------------------

describe("coach — scroll hunt", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const HIGH = COACH_TUNING.scrollHuntMinLinesFromBottom + 50;

  /** One full dwell episode in the given pane. */
  function dwell(d: ReturnType<typeof createScrollHuntDetector>, paneId = P) {
    d.onScroll(paneId, HIGH);
    vi.advanceTimersByTime(COACH_TUNING.scrollHuntDwellMs);
  }

  it("two dwells one day = one episode; two distinct days shelve", () => {
    const d = createScrollHuntDetector();
    dwell(d);
    dwell(d); // day 1 → episode recorded (count 1), below the 2-day bar
    expect(useCoachStore.getState().tips["scroll-hunt"].shelvedAt).toBeUndefined();
    expect(useCoachStore.getState().tips["scroll-hunt"].episodeDays.length).toBe(1);

    now = BASE + DAY; // a new calendar day
    dwell(d);
    dwell(d);
    expect(useCoachStore.getState().tips["scroll-hunt"].shelvedAt).toBeDefined();
  });

  it("one dwell in a run is not an episode", () => {
    const d = createScrollHuntDetector();
    dwell(d);
    expect(useCoachStore.getState().tips["scroll-hunt"]).toBeUndefined();
  });

  it("returning to the bottom before the dwell elapses cancels it", () => {
    const d = createScrollHuntDetector();
    d.onScroll(P, HIGH);
    vi.advanceTimersByTime(COACH_TUNING.scrollHuntDwellMs - 1);
    d.onScroll(P, 0); // back to bottom → dwell cancelled
    vi.advanceTimersByTime(COACH_TUNING.scrollHuntDwellMs);
    // Only a single genuine dwell should ever land; here none did.
    dwell(d); // 1 real dwell
    expect(useCoachStore.getState().tips["scroll-hunt"]).toBeUndefined();
  });

  it("opening terminal search graduates and stops shelving", () => {
    const d = createScrollHuntDetector();
    d.onSearchOpened();
    expect(useCoachStore.getState().tips["scroll-hunt"].graduatedAt).toBeDefined();
    // Two dwells across two days can no longer shelve.
    dwell(d);
    dwell(d);
    now = BASE + DAY;
    dwell(d);
    dwell(d);
    expect(useCoachStore.getState().tips["scroll-hunt"].shelvedAt).toBeUndefined();
  });

  it("does not observe while tips are off", () => {
    usePrefsStore.getState().setTipsEnabled(false);
    const d = createScrollHuntDetector();
    dwell(d);
    dwell(d);
    expect(useCoachStore.getState().tips["scroll-hunt"]).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Wiring — initCoach / disposeCoach
// ---------------------------------------------------------------------------

describe("coach — initCoach wiring", () => {
  afterEach(() => {
    disposeCoach();
  });

  it("retro-graduates session-thrash when a durable split group already exists", () => {
    const a = useSessionsStore.getState().createSession("C:/proj");
    const b = useSessionsStore.getState().createSession("C:/proj");
    useSessionsStore.getState().activateSession(a);
    useSessionsStore.getState().openSplitWith(b); // creates a durable group
    initCoach();
    expect(useCoachStore.getState().tips["session-thrash"].graduatedAt).toBeDefined();
  });

  it("routes deliberate navigation into the thrash detector", () => {
    const a = useSessionsStore.getState().createSession("C:/proj");
    const b = useSessionsStore.getState().createSession("C:/proj");
    initCoach();
    useSessionsStore.getState().activateSession(a);
    // 6 deliberate single↔single switches → a push at the pair.
    for (let i = 0; i < 6; i++) {
      emitSessionNavigation(i % 2 ? a : b, "sidebar");
      // flip active so the next emit has the right `from`
      useSessionsStore.getState().activateSession(i % 2 ? a : b);
    }
    expect(useCoachStore.getState().activeTip?.tipId).toBe("session-thrash");
  });

  it("suppresses thrash while a split view is open (both already visible)", () => {
    const a = useSessionsStore.getState().createSession("C:/proj");
    const b = useSessionsStore.getState().createSession("C:/proj");
    initCoach();
    useSessionsStore.getState().activateSession(a);
    useSessionsStore.getState().openSplitWith(b); // splitView = [a,b]
    for (let i = 0; i < 8; i++) emitSessionNavigation(i % 2 ? a : b, "keyboard");
    expect(useCoachStore.getState().activeTip).toBeNull();
  });

  it("clears a pair-anchored chip when a session is deleted (anchor death)", () => {
    const a = useSessionsStore.getState().createSession("C:/proj");
    const b = useSessionsStore.getState().createSession("C:/proj");
    initCoach();
    useCoachStore
      .getState()
      .tryPush("session-thrash", { kind: "session-pair", sessionIds: [a, b] });
    expect(useCoachStore.getState().activeTip).not.toBeNull();
    useSessionsStore.getState().purgeSession(b);
    expect(useCoachStore.getState().activeTip).toBeNull();
  });

  it("disposeCoach detaches — later navigation no longer reaches the detector", () => {
    const a = useSessionsStore.getState().createSession("C:/proj");
    const b = useSessionsStore.getState().createSession("C:/proj");
    initCoach();
    disposeCoach();
    useSessionsStore.getState().activateSession(a);
    for (let i = 0; i < 8; i++) {
      emitSessionNavigation(i % 2 ? a : b, "sidebar");
      useSessionsStore.getState().activateSession(i % 2 ? a : b);
    }
    expect(useCoachStore.getState().activeTip).toBeNull();
  });
});

import { describe, it, expect, beforeEach, vi } from "vitest";

// persist middleware pulls in plugin-store on import; stub it so no Tauri
// runtime is needed and NO real user config is ever touched.
vi.mock("@tauri-apps/plugin-store", () => ({
  load: vi.fn(async () => ({
    get: vi.fn(async () => null),
    set: vi.fn(async () => undefined),
    delete: vi.fn(async () => undefined),
  })),
}));

import {
  useCoachStore,
  coerceCoachRehydrated,
  localDay,
  calendarDaysBetween,
  noteTerminalInput,
  getLastTerminalInputAt,
  setCoachPaneSlotFree,
  __setCoachClock,
  __resetCoachClock,
  __setCoachAppStart,
  __resetCoachTiming,
  __resetCoachPaneSlotFree,
  type CoachAnchor,
} from "@/store/coachStore";
import { usePrefsStore } from "@/store/prefsStore";
import { useAgentStore } from "@/store/agentStore";
import { COACH_TUNING } from "@/sessions/coachCatalog";
import type { PaneId } from "@/types";

const DAY = 24 * 60 * 60 * 1000;
// Local noon on a fixed date — day math stays consistent because both localDay
// and the clock use the same local zone.
const BASE = new Date(2026, 5, 10, 12, 0, 0).getTime();

const PANE_ANCHOR: CoachAnchor = { kind: "pane", paneId: "p1" as PaneId };
const PAIR_ANCHOR: CoachAnchor = { kind: "session-pair", sessionIds: ["a", "b"] };

let now = BASE;

/** Put the world in a state where every gate passes for a fresh push. */
function primeGates(): void {
  now = BASE;
  __setCoachClock(() => now);
  __resetCoachTiming(); // lastInput → 0, appStart → now
  __setCoachAppStart(BASE - COACH_TUNING.appWarmupMs - 1000); // warmed up
}

beforeEach(() => {
  useCoachStore.getState().reset();
  usePrefsStore.getState().reset();
  useAgentStore.getState().reset();
  __resetCoachClock();
  __resetCoachPaneSlotFree();
  primeGates();
});

describe("coachStore — day helpers", () => {
  it("localDay renders a local YYYY-MM-DD", () => {
    expect(localDay(BASE)).toBe("2026-06-10");
    expect(localDay(BASE + DAY)).toBe("2026-06-11");
  });

  it("calendarDaysBetween counts whole calendar days", () => {
    expect(calendarDaysBetween("2026-06-11", "2026-06-10")).toBe(1);
    expect(calendarDaysBetween("2026-06-10", "2026-06-10")).toBe(0);
    expect(calendarDaysBetween("2026-06-17", "2026-06-10")).toBe(7);
  });
});

describe("coachStore — tryPush happy path + showing accounting", () => {
  it("pushes when every gate passes and records the showing", () => {
    const ok = useCoachStore.getState().tryPush("selection-rescue", PANE_ANCHOR);
    expect(ok).toBe(true);
    const s = useCoachStore.getState();
    expect(s.tips["selection-rescue"].shownCount).toBe(1);
    expect(s.pushDates).toEqual(["2026-06-10"]);
    expect(s.activeTip).toMatchObject({ tipId: "selection-rescue", anchor: PANE_ANCHOR });
    expect(s.activeTip?.shownAt).toBe(BASE);
  });

  it("carries the ephemeral payload onto activeTip only", () => {
    useCoachStore
      .getState()
      .tryPush("session-thrash", PAIR_ANCHOR, { left: "web", right: "api" });
    expect(useCoachStore.getState().activeTip?.payload).toEqual({ left: "web", right: "api" });
  });
});

describe("coachStore — gate 1: master switch", () => {
  it("no push while tips are disabled", () => {
    usePrefsStore.getState().setTipsEnabled(false);
    expect(useCoachStore.getState().tryPush("selection-rescue", PANE_ANCHOR)).toBe(false);
    expect(useCoachStore.getState().activeTip).toBeNull();
  });

  it("recordEpisode / shelve / graduate are no-ops while disabled", () => {
    usePrefsStore.getState().setTipsEnabled(false);
    expect(useCoachStore.getState().recordEpisode("scroll-hunt")).toBe(0);
    useCoachStore.getState().shelve("scroll-hunt");
    useCoachStore.getState().graduate("scroll-hunt");
    expect(useCoachStore.getState().tips["scroll-hunt"]).toBeUndefined();
  });

  it("toggling tips off clears a live chip; re-enabling does not replay it", () => {
    useCoachStore.getState().tryPush("selection-rescue", PANE_ANCHOR);
    expect(useCoachStore.getState().activeTip).not.toBeNull();
    usePrefsStore.getState().setTipsEnabled(false);
    expect(useCoachStore.getState().activeTip).toBeNull();
    usePrefsStore.getState().setTipsEnabled(true);
    expect(useCoachStore.getState().activeTip).toBeNull();
  });
});

describe("coachStore — gate 2: lifetime cap / graduated / dismissed", () => {
  it("stops at the lifetime cap (selection rescue = 2)", () => {
    // Two showings across two days (budget lets one per day).
    expect(useCoachStore.getState().tryPush("selection-rescue", PANE_ANCHOR)).toBe(true);
    now = BASE + DAY;
    expect(useCoachStore.getState().tryPush("selection-rescue", PANE_ANCHOR)).toBe(true);
    now = BASE + 2 * DAY;
    // shownCount is now 2 = cap → blocked regardless of budget.
    expect(useCoachStore.getState().tryPush("selection-rescue", PANE_ANCHOR)).toBe(false);
  });

  it("session thrash pushes once then never again (cap 1)", () => {
    expect(useCoachStore.getState().tryPush("session-thrash", PAIR_ANCHOR)).toBe(true);
    now = BASE + DAY;
    expect(useCoachStore.getState().tryPush("session-thrash", PAIR_ANCHOR)).toBe(false);
  });

  it("graduation retires the tip (precedence over an otherwise-valid push)", () => {
    useCoachStore.getState().graduate("selection-rescue");
    expect(useCoachStore.getState().tryPush("selection-rescue", PANE_ANCHOR)).toBe(false);
  });

  it("retro-graduation before any push keeps it retired", () => {
    // No episodes, no pushes yet — graduate first (existing durable split group,
    // existing Ctrl+F user, etc.), then it can never fire or accrue.
    useCoachStore.getState().graduate("scroll-hunt");
    expect(useCoachStore.getState().recordEpisode("scroll-hunt")).toBe(0);
    expect(useCoachStore.getState().tips["scroll-hunt"].episodeDays).toEqual([]);
  });

  it("a dismissed tip never pushes again", () => {
    useCoachStore.getState().dismissForever("selection-rescue");
    now = BASE + 30 * DAY; // long past the global quiet window
    expect(useCoachStore.getState().tryPush("selection-rescue", PANE_ANCHOR)).toBe(false);
  });
});

describe("coachStore — gate 3: global quiet after dismissal", () => {
  it("dismissForever on a push tip silences EVERY push for 7 days", () => {
    useCoachStore.getState().dismissForever("session-thrash");
    // A different, non-dismissed push tip is still silenced by the global quiet.
    now = BASE + DAY;
    expect(useCoachStore.getState().tryPush("selection-rescue", PANE_ANCHOR)).toBe(false);
    // After the quiet window it may push again.
    now = BASE + COACH_TUNING.dismissQuietMs + 1;
    expect(useCoachStore.getState().tryPush("selection-rescue", PANE_ANCHOR)).toBe(true);
  });
});

describe("coachStore — gate 4: budget (no exemptions)", () => {
  it("at most one push per calendar day", () => {
    expect(useCoachStore.getState().tryPush("selection-rescue", PANE_ANCHOR)).toBe(true);
    now = BASE + 6 * 60 * 60 * 1000; // same day, later
    expect(useCoachStore.getState().tryPush("selection-rescue", PANE_ANCHOR)).toBe(false);
  });

  it("just past midnight is a new calendar day", () => {
    expect(useCoachStore.getState().tryPush("selection-rescue", PANE_ANCHOR)).toBe(true);
    now = new Date(2026, 5, 11, 0, 0, 1).getTime(); // 00:00:01 next day
    expect(useCoachStore.getState().tryPush("selection-rescue", PANE_ANCHOR)).toBe(true);
  });

  it("at most two pushes in any trailing 7 days — rescues are NOT exempt", () => {
    // Day 1 + Day 2 use the budget (two different tips).
    expect(useCoachStore.getState().tryPush("session-thrash", PAIR_ANCHOR)).toBe(true);
    now = BASE + DAY;
    expect(useCoachStore.getState().tryPush("selection-rescue", PANE_ANCHOR)).toBe(true);
    // Day 3: budget is spent for the trailing week even for a rescue tip.
    now = BASE + 2 * DAY;
    expect(useCoachStore.getState().tryPush("selection-rescue", PANE_ANCHOR)).toBe(false);
  });

  it("the weekly window slides — a push frees up once the oldest falls out", () => {
    expect(useCoachStore.getState().tryPush("session-thrash", PAIR_ANCHOR)).toBe(true); // day 0
    now = BASE + DAY;
    expect(useCoachStore.getState().tryPush("selection-rescue", PANE_ANCHOR)).toBe(true); // day 1
    now = BASE + 7 * DAY; // day 0 is now 7 days out → outside the window
    expect(useCoachStore.getState().tryPush("selection-rescue", PANE_ANCHOR)).toBe(true);
  });
});

describe("coachStore — gate 5: timing seam", () => {
  it("blocked within 2s of terminal input", () => {
    noteTerminalInput("p1" as PaneId, now - 500);
    expect(useCoachStore.getState().tryPush("selection-rescue", PANE_ANCHOR)).toBe(false);
    noteTerminalInput("p1" as PaneId, now - (COACH_TUNING.terminalInputQuietMs + 1));
    expect(useCoachStore.getState().tryPush("selection-rescue", PANE_ANCHOR)).toBe(true);
  });

  it("blocked while any pane is blocked on permission (the dot wins)", () => {
    useAgentStore.getState().setPaneAgent("pX" as PaneId, {
      agent: "claude",
      phase: "permission",
      source: "hook",
    });
    expect(useCoachStore.getState().tryPush("selection-rescue", PANE_ANCHOR)).toBe(false);
  });

  it("blocked in the app's first two minutes", () => {
    __setCoachAppStart(now - 1000); // started 1s ago
    expect(useCoachStore.getState().tryPush("selection-rescue", PANE_ANCHOR)).toBe(false);
  });
});

describe("coachStore — gate 6: slot free (pane anchors only, no retry)", () => {
  it("a taken pane slot blocks a pane-anchored push", () => {
    setCoachPaneSlotFree(() => false);
    expect(useCoachStore.getState().tryPush("selection-rescue", PANE_ANCHOR)).toBe(false);
  });

  it("the session-pair anchor ignores pane-slot arbitration", () => {
    setCoachPaneSlotFree(() => false);
    expect(useCoachStore.getState().tryPush("session-thrash", PAIR_ANCHOR)).toBe(true);
  });
});

describe("coachStore — episodes + bounding", () => {
  it("recordEpisode accrues one entry per distinct day", () => {
    expect(useCoachStore.getState().recordEpisode("scroll-hunt")).toBe(1);
    expect(useCoachStore.getState().recordEpisode("scroll-hunt")).toBe(1); // same day
    now = BASE + DAY;
    expect(useCoachStore.getState().recordEpisode("scroll-hunt")).toBe(2);
  });

  it("episodeDays is bounded to the trailing 14-day window", () => {
    for (let i = 0; i < 20; i++) {
      now = BASE + i * DAY;
      useCoachStore.getState().recordEpisode("scroll-hunt");
    }
    const days = useCoachStore.getState().tips["scroll-hunt"].episodeDays;
    expect(days.length).toBeLessThanOrEqual(COACH_TUNING.episodeWindowDays);
    // Oldest surviving day is within the window of the last recording.
    expect(calendarDaysBetween(localDay(now), days[0])).toBeLessThan(
      COACH_TUNING.episodeWindowDays
    );
  });

  it("pushDates is bounded to pushDatesBound entries", () => {
    // Space pushes 4 days apart so the trailing-7 budget always admits one (the
    // only prior push in-window is 4 days back); clear tips each loop so the
    // lifetime cap never interferes. Ten pushes → bounded to pushDatesBound.
    for (let i = 0; i < 10; i++) {
      now = BASE + i * 4 * DAY;
      useCoachStore.setState((s) => {
        s.tips = {};
      });
      expect(useCoachStore.getState().tryPush("selection-rescue", PANE_ANCHOR)).toBe(true);
    }
    expect(useCoachStore.getState().pushDates.length).toBe(COACH_TUNING.pushDatesBound);
  });
});

describe("coachStore — shelf dot 7-day cap + clear on open", () => {
  it("first shelving lights the dot; a second (different tip) within 7 days does not", () => {
    useCoachStore.getState().shelve("scroll-hunt");
    expect(useCoachStore.getState().shelfHasNew).toBe(true);
    useCoachStore.getState().markShelfOpened();
    expect(useCoachStore.getState().shelfHasNew).toBe(false);

    now = BASE + DAY; // within the 7-day cooldown
    useCoachStore.getState().shelve("precise-signals");
    expect(useCoachStore.getState().shelfHasNew).toBe(false);

    now = BASE + COACH_TUNING.shelfDotCooldownMs + 1; // past the cooldown
    // A brand-new shelving (session-thrash, first time) may light again.
    useCoachStore.getState().shelve("session-thrash");
    expect(useCoachStore.getState().shelfHasNew).toBe(true);
  });

  it("re-shelving an already-shelved tip does not re-light the dot", () => {
    useCoachStore.getState().shelve("scroll-hunt");
    useCoachStore.getState().markShelfOpened();
    now = BASE + COACH_TUNING.shelfDotCooldownMs + 1;
    useCoachStore.getState().shelve("scroll-hunt"); // already shelved
    expect(useCoachStore.getState().shelfHasNew).toBe(false);
  });
});

describe("coachStore — reset + persistence", () => {
  it("resetLearnedTips clears history + activeTip but leaves tipsEnabled", () => {
    useCoachStore.getState().tryPush("selection-rescue", PANE_ANCHOR);
    useCoachStore.getState().shelve("scroll-hunt");
    usePrefsStore.getState().setTipsEnabled(true);

    useCoachStore.getState().resetLearnedTips();
    const s = useCoachStore.getState();
    expect(s.tips).toEqual({});
    expect(s.pushDates).toEqual([]);
    expect(s.activeTip).toBeNull();
    expect(s.shelfHasNew).toBe(false);
    // The preference is owned by prefsStore and is untouched.
    expect(usePrefsStore.getState().tipsEnabled).toBe(true);
  });

  it("partialize excludes the ephemeral activeTip", () => {
    useCoachStore.getState().tryPush("selection-rescue", PANE_ANCHOR);
    const persisted = useCoachStore.persist
      .getOptions()
      .partialize?.(useCoachStore.getState()) as Record<string, unknown>;
    expect(persisted).not.toHaveProperty("activeTip");
    expect(persisted).toHaveProperty("tips");
    expect(persisted).toHaveProperty("pushDates");
  });

  it("coerceCoachRehydrated bounds arrays and never restores activeTip", () => {
    const coerced = coerceCoachRehydrated({
      tips: {
        "scroll-hunt": {
          shownCount: 1,
          episodeDays: Array.from({ length: 30 }, (_, i) => `2026-06-${i + 1}`),
        },
      },
      pushDates: Array.from({ length: 20 }, (_, i) => `2026-06-${i + 1}`),
      shelfHasNew: true,
      // A stray activeTip on disk must never come back.
      activeTip: { tipId: "scroll-hunt", anchor: PANE_ANCHOR, shownAt: 1 },
    });
    expect(coerced.pushDates?.length).toBe(COACH_TUNING.pushDatesBound);
    expect(coerced.tips!["scroll-hunt"].episodeDays.length).toBe(COACH_TUNING.episodeWindowDays);
    expect(coerced.activeTip).toBeNull();
    expect(coerced.shelfHasNew).toBe(true);
  });
});

describe("coachStore — noteTerminalInput seam", () => {
  it("stamps only a timestamp (metadata only)", () => {
    __resetCoachTiming();
    expect(getLastTerminalInputAt()).toBe(0);
    noteTerminalInput("p9" as PaneId, 123456);
    expect(getLastTerminalInputAt()).toBe(123456);
  });
});

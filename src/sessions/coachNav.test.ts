import { describe, it, expect, beforeEach, vi } from "vitest";

// persist middleware (sessionsStore + coachStore) pulls in plugin-store on
// import; stub it so no Tauri runtime is needed.
vi.mock("@tauri-apps/plugin-store", () => ({
  load: vi.fn(async () => ({
    get: vi.fn(async () => null),
    set: vi.fn(async () => undefined),
    delete: vi.fn(async () => undefined),
  })),
}));

import {
  emitSessionNavigation,
  noteSessionNavigation,
  onSessionNavigation,
  __resetCoachNav,
  type SessionNavigation,
} from "@/sessions/coachNav";
import { useSessionsStore, type SessionId } from "@/store/sessionsStore";
import { usePrefsStore } from "@/store/prefsStore";
import { __setCoachClock } from "@/store/coachStore";

const AT = 1_700_000_000_000;

/** Create two sessions in one folder; return their ids. */
function seedTwo(): [SessionId, SessionId] {
  const a = useSessionsStore.getState().createSession("C:/proj");
  const b = useSessionsStore.getState().createSession("C:/proj");
  return [a, b];
}

let events: SessionNavigation[] = [];

beforeEach(() => {
  useSessionsStore.getState().reset();
  usePrefsStore.getState().reset();
  __resetCoachNav();
  __setCoachClock(() => AT);
  events = [];
  onSessionNavigation((e) => events.push(e));
});

describe("coachNav — emitSessionNavigation (deliberate switches)", () => {
  it("emits metadata only for a single → single switch", () => {
    const [a, b] = seedTwo();
    useSessionsStore.getState().activateSession(a);
    emitSessionNavigation(b, "sidebar");
    expect(events).toEqual([{ from: a, to: b, source: "sidebar", at: AT }]);
  });

  it("carries the keyboard source tag", () => {
    const [a, b] = seedTwo();
    useSessionsStore.getState().activateSession(a);
    emitSessionNavigation(b, "keyboard");
    expect(events[0]?.source).toBe("keyboard");
  });

  it("first activation emits from: null", () => {
    const [, b] = seedTwo();
    // activeSessionId still null (nothing activated yet).
    emitSessionNavigation(b, "sidebar");
    expect(events[0]).toEqual({ from: null, to: b, source: "sidebar", at: AT });
  });
});

describe("coachNav — suppression", () => {
  it("ignores a no-op (to === from)", () => {
    const [a] = seedTwo();
    useSessionsStore.getState().activateSession(a);
    emitSessionNavigation(a, "sidebar");
    expect(events).toHaveLength(0);
  });

  it("ignores navigation while a split view is open (both already visible)", () => {
    const [a, b] = seedTwo();
    useSessionsStore.getState().activateSession(a);
    useSessionsStore.getState().openSplitWith(b); // splitView = [a, b]
    emitSessionNavigation(b, "sidebar");
    emitSessionNavigation(a, "keyboard");
    expect(events).toHaveLength(0);
  });

  it("ignores a split-pair reopen (clicking a grouped, off-screen member)", () => {
    const [a, b] = seedTwo();
    const c = useSessionsStore.getState().createSession("C:/proj");
    // Form a durable pair [a, b], then navigate away so the split is not shown
    // but the group persists.
    useSessionsStore.getState().activateSession(a);
    useSessionsStore.getState().openSplitWith(b);
    useSessionsStore.getState().activateSession(c); // collapses splitView, keeps group
    expect(useSessionsStore.getState().splitView).toBeNull();
    events = [];
    emitSessionNavigation(a, "sidebar"); // reopening the pair, not a single switch
    expect(events).toHaveLength(0);
  });
});

describe("coachNav — master switch + non-entry points", () => {
  it("noteSessionNavigation is a no-op while tips are disabled", () => {
    usePrefsStore.getState().setTipsEnabled(false);
    noteSessionNavigation({ from: "a", to: "b", source: "sidebar", at: AT });
    expect(events).toHaveLength(0);
  });

  it("emitSessionNavigation forwards nothing while tips are disabled", () => {
    const [a, b] = seedTwo();
    useSessionsStore.getState().activateSession(a);
    usePrefsStore.getState().setTipsEnabled(false);
    emitSessionNavigation(b, "sidebar");
    expect(events).toHaveLength(0);
  });

  it("programmatic activation (activateSession) emits nothing", () => {
    const [a, b] = seedTwo();
    useSessionsStore.getState().activateSession(a);
    useSessionsStore.getState().activateSession(b);
    expect(events).toHaveLength(0);
  });

  it("boot restore (resumeSessions) emits nothing", () => {
    const [a, b] = seedTwo();
    useSessionsStore.getState().resumeSessions([a, b], a);
    expect(events).toHaveLength(0);
  });
});

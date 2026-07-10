import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";

vi.mock("@tauri-apps/plugin-store", () => ({
  load: vi.fn(async () => ({
    get: vi.fn(async () => null),
    set: vi.fn(async () => undefined),
    delete: vi.fn(async () => undefined),
  })),
}));

import { CoachChip } from "@/components/CoachChip";
import { useCoachStore, type CoachAnchor } from "@/store/coachStore";
import { usePaneResumeStore } from "@/store/paneResumeStore";
import { useAgentStore } from "@/store/agentStore";
import { COACH_TUNING } from "@/sessions/coachCatalog";
import type { PaneId } from "@/types";

const P = "p1" as PaneId;
const PANE_ANCHOR: CoachAnchor = { kind: "pane", paneId: P };
const PAIR_ANCHOR: CoachAnchor = { kind: "session-pair", sessionIds: ["a", "b"] };

function setActiveTip(anchor: CoachAnchor, tipId: "selection-rescue" | "session-thrash", payload?: Record<string, string>) {
  useCoachStore.setState((s) => {
    s.activeTip = { tipId, anchor, payload, shownAt: 1000 };
  });
}

beforeEach(() => {
  useCoachStore.getState().reset();
  usePaneResumeStore.getState().reset();
  useAgentStore.getState().reset();
});

describe("CoachChip — pane anchor", () => {
  it("renders the tip copy, the keycap, and the explicit dismissal", () => {
    setActiveTip(PANE_ANCHOR, "selection-rescue");
    render(<CoachChip paneId={P} />);
    expect(screen.getByText(/Hold Shift while dragging/i)).toBeTruthy();
    expect(screen.getByText("Shift")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Don.t suggest this/i })).toBeTruthy();
  });

  it("does not render for a different pane", () => {
    setActiveTip(PANE_ANCHOR, "selection-rescue");
    const { container } = render(<CoachChip paneId={"other" as PaneId} />);
    expect(container.firstChild).toBeNull();
  });

  it("yields the slot to a resume banner (never displaces it)", () => {
    setActiveTip(PANE_ANCHOR, "selection-rescue");
    usePaneResumeStore.getState().recordAgentStart(P, { agentSessionId: "s1", cwd: "/proj" });
    const { container } = render(<CoachChip paneId={P} />);
    expect(container.firstChild).toBeNull();
  });

  it("'Don't suggest this' dismisses the tip forever (+ global quiet)", () => {
    setActiveTip(PANE_ANCHOR, "selection-rescue");
    render(<CoachChip paneId={P} />);
    fireEvent.click(screen.getByRole("button", { name: /Don.t suggest this/i }));
    const s = useCoachStore.getState();
    expect(s.tips["selection-rescue"].dismissedAt).toBeDefined();
    expect(s.quietUntil).toBeDefined(); // a push tip → 7-day global quiet
    expect(s.activeTip).toBeNull();
  });
});

describe("CoachChip — session-pair anchor", () => {
  it("renders the thrash copy and names the observed pair from the payload", () => {
    setActiveTip(PAIR_ANCHOR, "session-thrash", { left: "web", right: "api" });
    render(<CoachChip />);
    expect(screen.getByText(/drag one onto the other/i)).toBeTruthy();
    expect(screen.getByText(/web/)).toBeTruthy();
    expect(screen.getByText(/api/)).toBeTruthy();
  });

  it("the pane-mounted instance ignores a session-pair tip", () => {
    setActiveTip(PAIR_ANCHOR, "session-thrash", { left: "web", right: "api" });
    const { container } = render(<CoachChip paneId={P} />);
    expect(container.firstChild).toBeNull();
  });
});

describe("CoachChip — auto-fade", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("clears the active tip after the auto-fade window ('not now')", () => {
    setActiveTip(PANE_ANCHOR, "selection-rescue");
    render(<CoachChip paneId={P} />);
    expect(useCoachStore.getState().activeTip).not.toBeNull();
    act(() => {
      vi.advanceTimersByTime(COACH_TUNING.autoFadeMs);
    });
    expect(useCoachStore.getState().activeTip).toBeNull();
  });
});

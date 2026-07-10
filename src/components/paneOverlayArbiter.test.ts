import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@tauri-apps/plugin-store", () => ({
  load: vi.fn(async () => ({
    get: vi.fn(async () => null),
    set: vi.fn(async () => undefined),
    delete: vi.fn(async () => undefined),
  })),
}));

import { paneOverlaySlot, isCoachPaneSlotFree } from "@/components/paneOverlayArbiter";
import { usePaneResumeStore } from "@/store/paneResumeStore";
import { useAgentStore } from "@/store/agentStore";
import type { PaneId } from "@/types";

const P = "p1" as PaneId;

beforeEach(() => {
  usePaneResumeStore.getState().reset();
  useAgentStore.getState().reset();
});

describe("paneOverlaySlot — priority ranking", () => {
  it("resume outranks everything", () => {
    expect(
      paneOverlaySlot({ resumeEligible: true, attemptEligible: true, coachEligible: true })
    ).toBe("resume");
  });

  it("attempt hint outranks the coach", () => {
    expect(
      paneOverlaySlot({ resumeEligible: false, attemptEligible: true, coachEligible: true })
    ).toBe("attempt-hint");
  });

  it("the coach only wins an otherwise-empty slot", () => {
    expect(
      paneOverlaySlot({ resumeEligible: false, attemptEligible: false, coachEligible: true })
    ).toBe("coach");
  });

  it("nothing wants the slot", () => {
    expect(
      paneOverlaySlot({ resumeEligible: false, attemptEligible: false, coachEligible: false })
    ).toBeNull();
  });
});

describe("isCoachPaneSlotFree — gate 6 predicate", () => {
  it("is free when no overlay contends", () => {
    expect(isCoachPaneSlotFree(P)).toBe(true);
  });

  it("is NOT free while a resume banner is eligible", () => {
    usePaneResumeStore.getState().recordAgentStart(P, { agentSessionId: "s1", cwd: "/proj" });
    expect(isCoachPaneSlotFree(P)).toBe(false);
  });

  it("becomes free again once a live agent registers (resume banner hides)", () => {
    usePaneResumeStore.getState().recordAgentStart(P, { agentSessionId: "s1", cwd: "/proj" });
    useAgentStore.getState().setPaneAgent(P, { agent: "claude", phase: "idle", source: "hook" });
    expect(isCoachPaneSlotFree(P)).toBe(true);
  });
});

import { describe, expect, it, vi } from "vitest";

// sessionSignal now imports getVisibleSessionIds from sessionsStore, which
// persists via plugin-store. Stub it so importing this module needs no Tauri
// runtime and never touches real user config.
vi.mock("@tauri-apps/plugin-store", () => ({
  load: vi.fn(async () => ({
    get: vi.fn(async () => null),
    set: vi.fn(async () => undefined),
    delete: vi.fn(async () => undefined),
  })),
}));

import { leaf, split } from "@/store/layout/tree";
import type { PaneAgent } from "@/store/agentStore";
import type { PaneId } from "@/types";
import {
  computeSessionSignal,
  sessionAgentView,
  signalReason,
  rollUpSignal,
} from "@/sessions/sessionSignal";

const agent = (phase: PaneAgent["phase"]): PaneAgent => ({
  agent: "claude",
  phase,
  source: "hook",
});
const named = (name: PaneAgent["agent"], phase: PaneAgent["phase"]): PaneAgent => ({
  agent: name,
  phase,
  source: "command",
});

describe("sessionSignal — sessionAgentView aggregation", () => {
  it("returns no agent when the session has none", () => {
    expect(sessionAgentView({}, { layoutRoot: leaf("p1") })).toEqual({
      agents: [],
      signal: null,
      signalAgent: null,
    });
  });

  it("surfaces the glyph agent even when idle, with a null signal", () => {
    const panes: Record<PaneId, PaneAgent> = { p1: agent("idle") };
    expect(sessionAgentView(panes, { layoutRoot: leaf("p1") })).toEqual({
      agents: ["claude"],
      signal: null,
      signalAgent: "claude",
    });
  });

  it("lists multiple distinct agents in pane-tree order, de-duplicated", () => {
    const panes: Record<PaneId, PaneAgent> = {
      pa: named("codex", "idle"),
      pb: named("claude", "idle"),
      pc: named("codex", "idle"), // duplicate agent — collapses
    };
    const root = split(
      "horizontal",
      0.5,
      leaf("pa"),
      split("vertical", 0.5, leaf("pb"), leaf("pc"))
    );
    expect(sessionAgentView(panes, { layoutRoot: root }).agents).toEqual(["codex", "claude"]);
  });

  it("signalAgent is the agent of the most-urgent pane", () => {
    const panes: Record<PaneId, PaneAgent> = {
      pa: named("codex", "working"),
      pb: named("claude", "permission"),
    };
    const root = split("horizontal", 0.5, leaf("pa"), leaf("pb"));
    const view = sessionAgentView(panes, { layoutRoot: root });
    expect(view.signal).toBe("permission");
    expect(view.signalAgent).toBe("claude");
  });

  it("picks the most-urgent phase across panes (permission > your-move > working)", () => {
    const panes: Record<PaneId, PaneAgent> = {
      pa: agent("working"),
      pb: agent("permission"),
    };
    const root = split("horizontal", 0.5, leaf("pa"), leaf("pb"));
    expect(sessionAgentView(panes, { layoutRoot: root }).signal).toBe("permission");
  });

  it("your-move outranks working", () => {
    const panes: Record<PaneId, PaneAgent> = {
      pa: agent("working"),
      pb: agent("your-move"),
    };
    const root = split("horizontal", 0.5, leaf("pa"), leaf("pb"));
    expect(sessionAgentView(panes, { layoutRoot: root }).signal).toBe("your-move");
  });
});

describe("sessionSignal — computeSessionSignal priority", () => {
  const base = { visible: false, unread: false, working: false, agentSignal: null } as const;

  it("visible sessions never signal", () => {
    expect(
      computeSessionSignal({ ...base, visible: true, agentSignal: "permission" })
    ).toBe("active");
  });

  it("permission is the most urgent background signal", () => {
    expect(computeSessionSignal({ ...base, agentSignal: "permission", working: true })).toBe(
      "permission"
    );
  });

  it("your-move (agent) and heuristic unread both resolve to your-move", () => {
    expect(computeSessionSignal({ ...base, agentSignal: "your-move" })).toBe("your-move");
    expect(computeSessionSignal({ ...base, unread: true })).toBe("your-move");
  });

  it("agent working and heuristic working both resolve to working", () => {
    expect(computeSessionSignal({ ...base, agentSignal: "working" })).toBe("working");
    expect(computeSessionSignal({ ...base, working: true })).toBe("working");
  });

  it("unread trumps working (generalized existing rule)", () => {
    expect(computeSessionSignal({ ...base, unread: true, working: true })).toBe("your-move");
  });

  it("nothing → idle", () => {
    expect(computeSessionSignal(base)).toBe("idle");
  });
});

describe("sessionSignal — rollUpSignal (collapsed group header)", () => {
  it("permission wins over everything", () => {
    expect(rollUpSignal(["working", "your-move", "permission", "idle"])).toBe("permission");
  });
  it("your-move beats working", () => {
    expect(rollUpSignal(["working", "your-move", "idle"])).toBe("your-move");
  });
  it("working when nothing more urgent", () => {
    expect(rollUpSignal(["idle", "working", "active"])).toBe("working");
  });
  it("null when only active/idle (nothing needs you)", () => {
    expect(rollUpSignal(["active", "idle", "idle"])).toBeNull();
    expect(rollUpSignal([])).toBeNull();
  });
});

describe("sessionSignal — reasons", () => {
  it("names the agent in the reason string", () => {
    expect(signalReason("permission", "claude")).toBe("Claude — waiting on permission");
    expect(signalReason("your-move", "claude")).toBe("Claude — turn complete");
    expect(signalReason("working", "claude")).toBe("Claude — working");
  });

  it("falls back to a generic reason with no agent", () => {
    expect(signalReason("working", null)).toBe("working");
    expect(signalReason("idle", null)).toBe("idle");
  });
});

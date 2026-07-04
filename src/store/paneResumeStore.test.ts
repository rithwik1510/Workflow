import { describe, it, expect, beforeEach, vi } from "vitest";

// persist middleware pulls in plugin-store on import; stub it so no Tauri runtime
// is needed and NO real user config is ever touched.
vi.mock("@tauri-apps/plugin-store", () => ({
  load: vi.fn(async () => ({
    get: vi.fn(async () => null),
    set: vi.fn(async () => undefined),
    delete: vi.fn(async () => undefined),
  })),
}));

import {
  usePaneResumeStore,
  applyPaneIdRemap,
  migrateResumeStore,
  _resetPaneResumeRemap,
} from "@/store/paneResumeStore";

const records = () => usePaneResumeStore.getState().records;

beforeEach(() => {
  usePaneResumeStore.getState().reset();
  _resetPaneResumeRemap();
});

describe("paneResumeStore — launch-command + hook lifecycle", () => {
  it("records a launch command with the agent + verbatim line, alive", () => {
    usePaneResumeStore
      .getState()
      .recordLaunchCommand("p1", { agent: "codex", launchCommand: "npx @openai/codex", cwd: "/w" });
    expect(records()["p1"]).toMatchObject({
      agent: "codex",
      launchCommand: "npx @openai/codex",
      cwd: "/w",
      aliveAtShutdown: true,
    });
    expect(records()["p1"].agentSessionId).toBeUndefined();
  });

  it("SessionStart upserts the resume id + cwd and keeps a prior launch command", () => {
    const r = usePaneResumeStore.getState();
    r.recordLaunchCommand("p1", { agent: "claude", launchCommand: "claude --model opus", cwd: "/w" });
    r.recordAgentStart("p1", { agentSessionId: "sess-1", cwd: "/w" });
    expect(records()["p1"]).toMatchObject({
      agent: "claude",
      launchCommand: "claude --model opus", // original flags preserved
      agentSessionId: "sess-1",
      cwd: "/w",
      aliveAtShutdown: true,
    });
  });

  it("SessionStart before any launch capture still records (out-of-order)", () => {
    usePaneResumeStore.getState().recordAgentStart("p1", { agentSessionId: "s", cwd: "/w" });
    expect(records()["p1"]).toMatchObject({
      agent: "claude",
      launchCommand: "claude", // sensible default until/if a real line arrives
      agentSessionId: "s",
      aliveAtShutdown: true,
    });
  });

  it("a different agent replaces the record and drops the stale resume id", () => {
    const r = usePaneResumeStore.getState();
    r.recordLaunchCommand("p1", { agent: "claude", launchCommand: "claude", cwd: "/w" });
    r.recordAgentStart("p1", { agentSessionId: "sess-1", cwd: "/w" });
    r.recordLaunchCommand("p1", { agent: "codex", launchCommand: "codex", cwd: "/w" });
    expect(records()["p1"].agent).toBe("codex");
    expect(records()["p1"].agentSessionId).toBeUndefined();
  });

  it("markEnded keeps the record but clears aliveAtShutdown", () => {
    const r = usePaneResumeStore.getState();
    r.recordAgentStart("p1", { agentSessionId: "s", cwd: "/w" });
    r.markEnded("p1");
    expect(records()["p1"]).toBeDefined();
    expect(records()["p1"].aliveAtShutdown).toBe(false);
  });

  it("clearRecord removes the record entirely", () => {
    const r = usePaneResumeStore.getState();
    r.recordAgentStart("p1", { agentSessionId: "s", cwd: "/w" });
    r.clearRecord("p1");
    expect(records()["p1"]).toBeUndefined();
  });
});

describe("paneResumeStore — record → shutdown → restore → clear", () => {
  it("survives the paneId remap so a restored pane keeps its record", () => {
    // Running: an agent was launched in old pane id.
    usePaneResumeStore
      .getState()
      .recordAgentStart("pane-101", { agentSessionId: "sess-9", cwd: "/proj" });
    // Shutdown persists aliveAtShutdown=true (still running).
    expect(records()["pane-101"].aliveAtShutdown).toBe(true);

    // Restore: sessionsStore reassigns pane-101 → pane-1 and hands us the map.
    applyPaneIdRemap({ "pane-101": "pane-1" });

    expect(records()["pane-101"]).toBeUndefined();
    expect(records()["pane-1"]).toMatchObject({
      agent: "claude",
      agentSessionId: "sess-9",
      cwd: "/proj",
      aliveAtShutdown: true,
    });

    // User clicks Just shell (or resumes) → record cleared.
    usePaneResumeStore.getState().clearRecord("pane-1");
    expect(records()["pane-1"]).toBeUndefined();
  });

  it("re-applying a remap is a no-op (idempotent under fresh ids)", () => {
    usePaneResumeStore.getState().recordAgentStart("old", { agentSessionId: "s", cwd: null });
    applyPaneIdRemap({ old: "new" });
    applyPaneIdRemap({ old: "new" });
    expect(Object.keys(records())).toEqual(["new"]);
  });
});

describe("paneResumeStore — auto-resume preference", () => {
  it("defaults OFF and toggles", () => {
    expect(usePaneResumeStore.getState().autoResumeOnRestore).toBe(false);
    usePaneResumeStore.getState().setAutoResumeOnRestore(true);
    expect(usePaneResumeStore.getState().autoResumeOnRestore).toBe(true);
  });
});

describe("paneResumeStore — v1→v2 migration (the empty-session heal)", () => {
  it("strips every v1 session id (untrustworthy) but keeps the records", () => {
    const v1 = {
      records: {
        "pane-1": {
          agent: "claude",
          launchCommand: "claude --resume dead-id",
          agentSessionId: "dead-id",
          cwd: "C:\proj",
          aliveAtShutdown: true,
          lastSeenAt: 1,
        },
      },
      autoResumeOnRestore: true,
    };
    const out = migrateResumeStore(v1, 1) as typeof v1;
    expect(out.records["pane-1"].agentSessionId).toBeUndefined();
    expect(out.records["pane-1"].agent).toBe("claude"); // record itself survives
    expect(out.autoResumeOnRestore).toBe(true);
  });

  it("passes v2+ state through untouched", () => {
    const v2 = { records: {}, autoResumeOnRestore: false };
    expect(migrateResumeStore(v2, 2)).toBe(v2);
  });
});

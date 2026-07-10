import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";

// sessionsStore pulls in the persist middleware (plugin-store) on import.
vi.mock("@tauri-apps/plugin-store", () => ({
  load: vi.fn(async () => ({
    get: vi.fn(async () => null),
    set: vi.fn(async () => undefined),
    delete: vi.fn(async () => undefined),
  })),
}));
// agentTracker imports `listen`; we never call installAgentTracker in these
// tests (we drive applyAgentEvent directly), but stub the module so the import
// resolves without a Tauri runtime.
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => undefined),
}));

import { useSessionsStore } from "@/store/sessionsStore";
import { useAgentStore } from "@/store/agentStore";
import { leaf } from "@/store/layout/tree";
import {
  applyAgentEvent,
  transitionFor,
  forgetPaneAgent,
  noteCommandAgent,
  disposeAgentTracker,
  type AgentEvent,
} from "@/sessions/agentTracker";
import {
  noteOutput,
  disposeAttentionTracker,
  paneHasLiveAgent,
} from "@/sessions/attentionTracker";
import { handleOsc133, disposeCommandTracker } from "@/sessions/commandTracker";
import { sessionAgentView } from "@/sessions/sessionSignal";

function sessionWithPane(folder: string, paneId: string): string {
  const s = useSessionsStore.getState();
  const id = s.createSession(folder);
  s.setLayoutRoot(id, leaf(paneId));
  return id;
}

const phase = (paneId: string) => useAgentStore.getState().panes[paneId]?.phase;
const subagents = (paneId: string) => useAgentStore.getState().panes[paneId]?.liveSubagents;
const working = (id: string) => useSessionsStore.getState().sessions[id].working;
/** The sidebar signal a background session would render, derived exactly as
 *  SessionRow does (effective phase → agentSignal). */
const sidebarSignal = (id: string) =>
  sessionAgentView(useAgentStore.getState().panes, useSessionsStore.getState().sessions[id]).signal;

function ev(paneId: string, event: string, extra: Partial<AgentEvent> = {}): AgentEvent {
  return { paneId, event, ...extra };
}

/** A REAL cadence stream (two throttled chunks inside SUSTAIN_MS) — used to
 *  prove cadence is/ isn't suppressed for a pane. */
function streamOutput(paneId: string): void {
  noteOutput(paneId);
  vi.advanceTimersByTime(250);
  noteOutput(paneId);
}

/** Drive a full OSC 133 command (start → finish) so the command-finished
 *  subscription fires — the shell-level "the launched process exited" signal. */
function finishCommand(paneId: string): void {
  handleOsc133(paneId, "C");
  handleOsc133(paneId, "D;0");
}

beforeEach(() => {
  useSessionsStore.setState(useSessionsStore.getInitialState(), true);
  disposeAgentTracker();
  disposeAttentionTracker();
  disposeCommandTracker();
  vi.useFakeTimers();
});
afterEach(() => {
  disposeAgentTracker();
  disposeAttentionTracker();
  disposeCommandTracker();
  vi.useRealTimers();
});

describe("agentTracker — transitionFor (pure)", () => {
  it("maps each known event/kind to its transition", () => {
    expect(transitionFor("SessionStart")).toEqual({ type: "phase", phase: "idle" });
    expect(transitionFor("UserPromptSubmit")).toEqual({ type: "phase", phase: "working" });
    expect(transitionFor("Stop")).toEqual({ type: "phase", phase: "your-move" });
    expect(transitionFor("SessionEnd")).toEqual({ type: "end" });
    expect(transitionFor("Notification", "permission_prompt")).toEqual({
      type: "phase",
      phase: "permission",
    });
    // idle_prompt collapses into your-move (locked Design).
    expect(transitionFor("Notification", "idle_prompt")).toEqual({
      type: "phase",
      phase: "your-move",
    });
  });

  it("maps subagent lifecycle events to count deltas, not phase moves", () => {
    expect(transitionFor("SubagentStart")).toEqual({ type: "subagent", delta: 1 });
    expect(transitionFor("SubagentStop")).toEqual({ type: "subagent", delta: -1 });
  });

  it("tolerates unknown events and unknown notification kinds", () => {
    expect(transitionFor("PreToolUse")).toEqual({ type: "ignore" });
    expect(transitionFor("SomethingNew")).toEqual({ type: "ignore" });
    expect(transitionFor("Notification", "future_kind")).toEqual({ type: "ignore" });
    expect(transitionFor("Notification")).toEqual({ type: "ignore" });
  });
});

describe("agentTracker — state machine over a session lifecycle", () => {
  it("SessionStart → UserPromptSubmit → permission → Stop → SessionEnd", () => {
    const bg = sessionWithPane("/bg", "pane-bg");
    const fg = sessionWithPane("/fg", "pane-fg");
    useSessionsStore.getState().activateSession(fg);

    applyAgentEvent(ev("pane-bg", "SessionStart", { sessionId: "s1", transcriptPath: "/t" }));
    expect(phase("pane-bg")).toBe("idle");
    expect(useAgentStore.getState().panes["pane-bg"].agent).toBe("claude");
    expect(useAgentStore.getState().panes["pane-bg"].sessionId).toBe("s1");
    expect(paneHasLiveAgent("pane-bg")).toBe(true);
    expect(working(bg)).toBe(false); // idle is not working

    applyAgentEvent(ev("pane-bg", "UserPromptSubmit"));
    expect(phase("pane-bg")).toBe("working");
    expect(working(bg)).toBe(true); // class A drives the session working fact
    // Identity is preserved across the transition.
    expect(useAgentStore.getState().panes["pane-bg"].sessionId).toBe("s1");

    applyAgentEvent(ev("pane-bg", "Notification", { kind: "permission_prompt" }));
    expect(phase("pane-bg")).toBe("permission");
    expect(working(bg)).toBe(false); // blocked is not working

    applyAgentEvent(ev("pane-bg", "Stop"));
    expect(phase("pane-bg")).toBe("your-move");
    expect(working(bg)).toBe(false);

    applyAgentEvent(ev("pane-bg", "SessionEnd"));
    expect(phase("pane-bg")).toBeUndefined(); // entry removed
    expect(paneHasLiveAgent("pane-bg")).toBe(false); // reverts to heuristics
  });

  it("idle_prompt notification also lands 'your-move'", () => {
    sessionWithPane("/bg", "pane-bg");
    applyAgentEvent(ev("pane-bg", "SessionStart"));
    applyAgentEvent(ev("pane-bg", "Notification", { kind: "idle_prompt" }));
    expect(phase("pane-bg")).toBe("your-move");
  });
});

describe("agentTracker — background subagents keep the session working past Stop", () => {
  // The captured edge case (pane-119.jsonl): the MAIN agent's Stop fires while a
  // background subagent is still running, so the session must NOT flip to the
  // your-move dot until the last subagent reports done.
  it("Stop while a subagent is live still reads working, then your-move on SubagentStop", () => {
    const bg = sessionWithPane("/bg", "pane-bg");
    const fg = sessionWithPane("/fg", "pane-fg");
    useSessionsStore.getState().activateSession(fg);

    applyAgentEvent(ev("pane-bg", "SessionStart"));
    applyAgentEvent(ev("pane-bg", "UserPromptSubmit"));
    applyAgentEvent(ev("pane-bg", "SubagentStart"));
    expect(subagents("pane-bg")).toBe(1);
    expect(working(bg)).toBe(true);

    // Main turn ends but the subagent runs on: phase is your-move underneath,
    // yet the session still presents as working.
    applyAgentEvent(ev("pane-bg", "Stop"));
    expect(phase("pane-bg")).toBe("your-move");
    expect(subagents("pane-bg")).toBe(1); // carried across the Stop
    expect(working(bg)).toBe(true);
    expect(sidebarSignal(bg)).toBe("working");

    // The subagent finishes → now it's genuinely your move.
    applyAgentEvent(ev("pane-bg", "SubagentStop"));
    expect(subagents("pane-bg")).toBe(0);
    expect(working(bg)).toBe(false);
    expect(sidebarSignal(bg)).toBe("your-move");
  });

  it("the auto-resume UserPromptSubmit flips it back to working", () => {
    const bg = sessionWithPane("/bg", "pane-bg");
    const fg = sessionWithPane("/fg", "pane-fg");
    useSessionsStore.getState().activateSession(fg);

    applyAgentEvent(ev("pane-bg", "SessionStart"));
    applyAgentEvent(ev("pane-bg", "UserPromptSubmit"));
    applyAgentEvent(ev("pane-bg", "SubagentStart"));
    applyAgentEvent(ev("pane-bg", "Stop"));
    applyAgentEvent(ev("pane-bg", "SubagentStop"));
    expect(sidebarSignal(bg)).toBe("your-move");

    // Main agent auto-resumes to process the subagent's result.
    applyAgentEvent(ev("pane-bg", "UserPromptSubmit"));
    expect(phase("pane-bg")).toBe("working");
    expect(sidebarSignal(bg)).toBe("working");
  });

  it("permission still outranks a live subagent", () => {
    const bg = sessionWithPane("/bg", "pane-bg");
    const fg = sessionWithPane("/fg", "pane-fg");
    useSessionsStore.getState().activateSession(fg);

    applyAgentEvent(ev("pane-bg", "SessionStart"));
    applyAgentEvent(ev("pane-bg", "UserPromptSubmit"));
    applyAgentEvent(ev("pane-bg", "SubagentStart"));
    applyAgentEvent(ev("pane-bg", "Notification", { kind: "permission_prompt" }));
    expect(sidebarSignal(bg)).toBe("permission");
    expect(working(bg)).toBe(false); // blocked, even with a subagent live
  });

  it("count floors at 0 — a stray SubagentStop can't go negative", () => {
    sessionWithPane("/bg", "pane-bg");
    applyAgentEvent(ev("pane-bg", "SessionStart"));
    applyAgentEvent(ev("pane-bg", "SubagentStop"));
    // No entry-less crash, no negative: the pane stays at 0.
    expect(subagents("pane-bg")).toBe(0);
  });

  it("an out-of-order SubagentStart before SessionStart seeds a live claude entry", () => {
    const bg = sessionWithPane("/bg", "pane-bg");
    const fg = sessionWithPane("/fg", "pane-fg");
    useSessionsStore.getState().activateSession(fg);

    applyAgentEvent(ev("pane-bg", "SubagentStart"));
    expect(useAgentStore.getState().panes["pane-bg"]).toMatchObject({
      agent: "claude",
      source: "hook",
      liveSubagents: 1,
    });
    expect(paneHasLiveAgent("pane-bg")).toBe(true);
    expect(sidebarSignal(bg)).toBe("working");
  });

  it("a fresh user turn resets the count so a missed SubagentStop can't leak", () => {
    const bg = sessionWithPane("/bg", "pane-bg");
    const fg = sessionWithPane("/fg", "pane-fg");
    useSessionsStore.getState().activateSession(fg);

    applyAgentEvent(ev("pane-bg", "SessionStart"));
    applyAgentEvent(ev("pane-bg", "UserPromptSubmit"));
    applyAgentEvent(ev("pane-bg", "SubagentStart")); // never gets its SubagentStop
    applyAgentEvent(ev("pane-bg", "Stop"));
    expect(subagents("pane-bg")).toBe(1); // still leaked into your-move state

    // The next turn wipes the stale count — the leak is bounded to one turn.
    applyAgentEvent(ev("pane-bg", "UserPromptSubmit"));
    expect(subagents("pane-bg")).toBe(0);
    applyAgentEvent(ev("pane-bg", "Stop"));
    expect(sidebarSignal(bg)).toBe("your-move"); // recovers cleanly
  });

  it("SessionEnd clears the subagent count with the entry", () => {
    sessionWithPane("/bg", "pane-bg");
    applyAgentEvent(ev("pane-bg", "SessionStart"));
    applyAgentEvent(ev("pane-bg", "SubagentStart"));
    applyAgentEvent(ev("pane-bg", "SessionEnd"));
    expect(useAgentStore.getState().panes["pane-bg"]).toBeUndefined();
  });
});

describe("agentTracker — tolerance", () => {
  it("out-of-order: UserPromptSubmit before its SessionStart still works", () => {
    const bg = sessionWithPane("/bg", "pane-bg");
    const fg = sessionWithPane("/fg", "pane-fg");
    useSessionsStore.getState().activateSession(fg);

    applyAgentEvent(ev("pane-bg", "UserPromptSubmit"));
    expect(phase("pane-bg")).toBe("working");
    expect(useAgentStore.getState().panes["pane-bg"].agent).toBe("claude");
    expect(working(bg)).toBe(true);
  });

  it("unknown events never create or mutate agent state", () => {
    sessionWithPane("/bg", "pane-bg");
    applyAgentEvent(ev("pane-bg", "PreToolUse"));
    expect(phase("pane-bg")).toBeUndefined();
    expect(paneHasLiveAgent("pane-bg")).toBe(false);

    applyAgentEvent(ev("pane-bg", "SessionStart"));
    applyAgentEvent(ev("pane-bg", "UserPromptSubmit"));
    expect(phase("pane-bg")).toBe("working");
    applyAgentEvent(ev("pane-bg", "PostToolUse")); // unknown mid-turn → no change
    expect(phase("pane-bg")).toBe("working");
  });
});

describe("agentTracker — your-move acknowledgment (viewing calms the dot)", () => {
  it("a Stop on the session you're viewing lands idle, not your-move", () => {
    const fg = sessionWithPane("/fg", "pane-fg");
    useSessionsStore.getState().activateSession(fg);
    applyAgentEvent(ev("pane-fg", "SessionStart"));
    applyAgentEvent(ev("pane-fg", "UserPromptSubmit"));
    applyAgentEvent(ev("pane-fg", "Stop"));
    // You watched the turn complete — no dot debt to carry into the sidebar.
    expect(phase("pane-fg")).toBe("idle");
  });

  it("a hidden your-move lights, then calms the moment the session is viewed", () => {
    const bg = sessionWithPane("/bg", "pane-bg");
    const fg = sessionWithPane("/fg", "pane-fg");
    useSessionsStore.getState().activateSession(fg);

    applyAgentEvent(ev("pane-bg", "SessionStart"));
    applyAgentEvent(ev("pane-bg", "Stop"));
    expect(phase("pane-bg")).toBe("your-move");

    useSessionsStore.getState().activateSession(bg); // view it
    expect(phase("pane-bg")).toBe("idle"); // acknowledged — won't relight on switch-away
  });

  it("permission is NOT acknowledgeable by viewing — still blocked, still urgent", () => {
    const bg = sessionWithPane("/bg", "pane-bg");
    const fg = sessionWithPane("/fg", "pane-fg");
    useSessionsStore.getState().activateSession(fg);

    applyAgentEvent(ev("pane-bg", "SessionStart"));
    applyAgentEvent(ev("pane-bg", "UserPromptSubmit"));
    applyAgentEvent(ev("pane-bg", "Notification", { kind: "permission_prompt" }));
    expect(phase("pane-bg")).toBe("permission");

    useSessionsStore.getState().activateSession(bg); // viewing doesn't unblock it
    expect(phase("pane-bg")).toBe("permission");
  });
});

describe("agentTracker — permission exits on sustained output", () => {
  // Approving a permission prompt fires no hook event until the turn ends, so
  // sustained output is the exit: demote to working, never leave the urgent
  // ring lying for the rest of the turn.
  it("two chunks within the sustain window demote permission → working", () => {
    const bg = sessionWithPane("/bg", "pane-bg");
    const fg = sessionWithPane("/fg", "pane-fg");
    useSessionsStore.getState().activateSession(fg);

    applyAgentEvent(ev("pane-bg", "SessionStart"));
    applyAgentEvent(ev("pane-bg", "UserPromptSubmit"));
    applyAgentEvent(ev("pane-bg", "Notification", { kind: "permission_prompt" }));
    expect(working(bg)).toBe(false);

    streamOutput("pane-bg"); // the approved tool starts streaming
    expect(phase("pane-bg")).toBe("working");
    expect(working(bg)).toBe(true);

    // The exact events still own the pane: the turn's Stop lands normally.
    applyAgentEvent(ev("pane-bg", "Stop"));
    expect(phase("pane-bg")).toBe("your-move");
    expect(working(bg)).toBe(false);
  });

  it("an isolated chunk (idle repaint) does not unblock the ring", () => {
    const bg = sessionWithPane("/bg", "pane-bg");
    const fg = sessionWithPane("/fg", "pane-fg");
    useSessionsStore.getState().activateSession(fg);

    applyAgentEvent(ev("pane-bg", "SessionStart"));
    applyAgentEvent(ev("pane-bg", "Notification", { kind: "permission_prompt" }));

    noteOutput("pane-bg"); // one lonely repaint
    expect(phase("pane-bg")).toBe("permission");

    // Another lone chunk far outside the sustain window re-arms, nothing more.
    vi.advanceTimersByTime(3000);
    noteOutput("pane-bg");
    expect(phase("pane-bg")).toBe("permission");
    expect(working(bg)).toBe(false);
  });

  it("your-move panes ignore output entirely (no phantom working)", () => {
    const bg = sessionWithPane("/bg", "pane-bg");
    const fg = sessionWithPane("/fg", "pane-fg");
    useSessionsStore.getState().activateSession(fg);

    applyAgentEvent(ev("pane-bg", "SessionStart"));
    applyAgentEvent(ev("pane-bg", "Stop"));
    expect(phase("pane-bg")).toBe("your-move");

    streamOutput("pane-bg"); // scrollback echoes, repaints — not a turn
    expect(phase("pane-bg")).toBe("your-move");
    expect(working(bg)).toBe(false);
  });
});

describe("agentTracker — class-A ownership over cadence", () => {
  it("suppresses cadence while the agent lives, resumes it after SessionEnd", () => {
    const bg = sessionWithPane("/bg", "pane-bg");
    const fg = sessionWithPane("/fg", "pane-fg");
    useSessionsStore.getState().activateSession(fg);

    applyAgentEvent(ev("pane-bg", "SessionStart"));
    // Agent is idle; a burst of terminal repaints must NOT spin the ring.
    streamOutput("pane-bg");
    expect(working(bg)).toBe(false);

    // Only the agent's own turn signal makes it working.
    applyAgentEvent(ev("pane-bg", "UserPromptSubmit"));
    expect(working(bg)).toBe(true);
    applyAgentEvent(ev("pane-bg", "Stop"));
    expect(working(bg)).toBe(false);

    // Agent gone → cadence heuristic is authoritative again.
    applyAgentEvent(ev("pane-bg", "SessionEnd"));
    streamOutput("pane-bg");
    expect(working(bg)).toBe(true);
  });

  it("forgetPaneAgent drops agent state and hands the pane back to heuristics", () => {
    const bg = sessionWithPane("/bg", "pane-bg");
    const fg = sessionWithPane("/fg", "pane-fg");
    useSessionsStore.getState().activateSession(fg);

    applyAgentEvent(ev("pane-bg", "SessionStart"));
    applyAgentEvent(ev("pane-bg", "UserPromptSubmit"));
    expect(working(bg)).toBe(true);

    forgetPaneAgent("pane-bg");
    expect(phase("pane-bg")).toBeUndefined();
    expect(paneHasLiveAgent("pane-bg")).toBe(false);
    expect(working(bg)).toBe(false);
  });
});

describe("agentTracker — command-derived identity (glyph-only)", () => {
  it("registers an idle, command-sourced identity from a launch command", () => {
    sessionWithPane("/bg", "pane-bg");
    noteCommandAgent("pane-bg", "npx -y @openai/codex");
    const pa = useAgentStore.getState().panes["pane-bg"];
    expect(pa).toMatchObject({ agent: "codex", phase: "idle", source: "command" });
  });

  it("ignores a command that names no known agent", () => {
    sessionWithPane("/bg", "pane-bg");
    noteCommandAgent("pane-bg", "git status");
    expect(useAgentStore.getState().panes["pane-bg"]).toBeUndefined();
  });

  it("does NOT take class-A ownership — heuristic cadence still drives working", () => {
    const bg = sessionWithPane("/bg", "pane-bg");
    const fg = sessionWithPane("/fg", "pane-fg");
    useSessionsStore.getState().activateSession(fg);

    noteCommandAgent("pane-bg", "codex");
    expect(paneHasLiveAgent("pane-bg")).toBe(false); // NOT owned
    expect(working(bg)).toBe(false); // idle phase contributes no signal

    // Cadence is NOT suppressed: streaming output makes the session working,
    // exactly as it would for any unhooked pane.
    streamOutput("pane-bg");
    expect(working(bg)).toBe(true);
  });

  it("a hook event upgrades a command identity to hook-owned Claude", () => {
    sessionWithPane("/bg", "pane-bg");
    const fg = sessionWithPane("/fg", "pane-fg");
    useSessionsStore.getState().activateSession(fg);

    noteCommandAgent("pane-bg", "claude");
    expect(useAgentStore.getState().panes["pane-bg"].source).toBe("command");

    applyAgentEvent(ev("pane-bg", "SessionStart", { sessionId: "s1" }));
    const pa = useAgentStore.getState().panes["pane-bg"];
    expect(pa).toMatchObject({ agent: "claude", source: "hook", sessionId: "s1" });
    expect(paneHasLiveAgent("pane-bg")).toBe(true);
  });

  it("never overwrites an existing hook entry", () => {
    sessionWithPane("/bg", "pane-bg");
    applyAgentEvent(ev("pane-bg", "SessionStart"));
    applyAgentEvent(ev("pane-bg", "UserPromptSubmit")); // hook says working
    noteCommandAgent("pane-bg", "codex"); // a re-typed command must not clobber
    const pa = useAgentStore.getState().panes["pane-bg"];
    expect(pa).toMatchObject({ agent: "claude", phase: "working", source: "hook" });
  });

  it("command-finished clears a command identity", () => {
    sessionWithPane("/bg", "pane-bg");
    noteCommandAgent("pane-bg", "gemini");
    expect(useAgentStore.getState().panes["pane-bg"].agent).toBe("gemini");
    finishCommand("pane-bg");
    expect(useAgentStore.getState().panes["pane-bg"]).toBeUndefined();
  });

  it("command-finished does NOT clear a hook identity", () => {
    sessionWithPane("/bg", "pane-bg");
    applyAgentEvent(ev("pane-bg", "SessionStart"));
    // A D mark can arrive before SessionEnd (claude is one long command); the
    // hook entry must survive it — only SessionEnd/forgetPaneAgent remove it.
    finishCommand("pane-bg");
    expect(useAgentStore.getState().panes["pane-bg"]).toMatchObject({
      agent: "claude",
      source: "hook",
    });
  });
});

// ---------------------------------------------------------------------------
// Resume-id recording (Plan 009 + the empty-session fix). Claude only writes a
// transcript once a message lands, so an id from SessionStart alone resumes
// NOTHING ("No conversation found") — the id must only be recorded on the
// first content evidence, and an empty session must never clobber the previous
// real conversation's id.
// ---------------------------------------------------------------------------

import { usePaneResumeStore } from "@/store/paneResumeStore";

describe("agentTracker — resume-id trust rules", () => {
  beforeEach(() => {
    usePaneResumeStore.getState().reset();
  });

  const recordedId = (paneId: string) =>
    usePaneResumeStore.getState().records[paneId]?.agentSessionId;

  it("SessionStart records the pane (alive, cwd) but NOT the session id", () => {
    sessionWithPane("/bg", "pane-bg");
    applyAgentEvent(ev("pane-bg", "SessionStart", { sessionId: "empty-1", cwd: "/bg" }));
    const rec = usePaneResumeStore.getState().records["pane-bg"];
    expect(rec).toMatchObject({ agent: "claude", cwd: "/bg", aliveAtShutdown: true });
    expect(rec?.agentSessionId).toBeUndefined();
  });

  it("UserPromptSubmit is content evidence — the id becomes the resume target", () => {
    sessionWithPane("/bg", "pane-bg");
    applyAgentEvent(ev("pane-bg", "SessionStart", { sessionId: "s-1" }));
    applyAgentEvent(ev("pane-bg", "UserPromptSubmit", { sessionId: "s-1" }));
    expect(recordedId("pane-bg")).toBe("s-1");
  });

  it("Stop and permission_prompt also count as content evidence", () => {
    sessionWithPane("/bg", "pane-bg");
    applyAgentEvent(ev("pane-bg", "Stop", { sessionId: "s-stop" }));
    expect(recordedId("pane-bg")).toBe("s-stop");
    applyAgentEvent(
      ev("pane-bg", "Notification", { kind: "permission_prompt", sessionId: "s-perm" })
    );
    expect(recordedId("pane-bg")).toBe("s-perm");
  });

  it("idle_prompt is NOT evidence (it can fire on an empty session at its prompt)", () => {
    sessionWithPane("/bg", "pane-bg");
    applyAgentEvent(ev("pane-bg", "Notification", { kind: "idle_prompt", sessionId: "s-idle" }));
    expect(recordedId("pane-bg")).toBeUndefined();
  });

  it("an empty follow-up session never clobbers the real conversation's id", () => {
    sessionWithPane("/bg", "pane-bg");
    // Real conversation: start + a prompt.
    applyAgentEvent(ev("pane-bg", "SessionStart", { sessionId: "real" }));
    applyAgentEvent(ev("pane-bg", "UserPromptSubmit", { sessionId: "real" }));
    applyAgentEvent(ev("pane-bg", "SessionEnd", { sessionId: "real" }));
    // Fresh claude launched, never conversed, app closed: only a SessionStart.
    applyAgentEvent(ev("pane-bg", "SessionStart", { sessionId: "empty" }));
    expect(recordedId("pane-bg")).toBe("real"); // the resumable one survives
  });
});

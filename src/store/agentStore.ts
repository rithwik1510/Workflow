// agentStore — transient per-pane state of hooked coding agents (Plan 008 §5).
//
// This is the frontend face of the deterministic "class A" signal: the Rust
// spool watcher emits `agent-event`, sessions/agentTracker runs the per-pane
// state machine, and the result lands here for the sidebar to render (blocked
// ring / your-move dot / agent glyph). NEVER persisted — an agent's state is
// meaningless across a restart (the PTY and the agent are both gone), exactly
// like sessionsStore.working / unread.
//
// Keyed by paneId (a session can run several agents, one per pane); the sidebar
// aggregates a session's panes via sessions/sessionSignal.

import { create } from "zustand";
import { immer } from "zustand/middleware/immer";

import type { PaneId } from "@/types";

/** The agents Lume can identify. Claude's exact phases come from hooks; Codex
 *  and Gemini are identified glyph-only from their launch command (no hook
 *  mechanism wired), so their panes keep the output heuristics for signals. */
export type AgentName = "claude" | "codex" | "gemini";

/** Per-pane agent phase. `idle` = SessionStart seen, no turn yet (calm, no
 *  signal); `working` = a turn is in progress; `permission` = blocked mid-turn
 *  on a permission prompt; `your-move` = turn complete / waiting at the prompt
 *  (Stop and idle_prompt collapse here). SessionEnd removes the entry. */
export type AgentPhase = "idle" | "working" | "permission" | "your-move";

/** How the pane's identity was learned. `hook` = a Claude hook event (class A
 *  owns the pane's exact phase). `command` = inferred from the launch command
 *  (glyph-only, phase stays `idle`, heuristics keep driving signals). A hook
 *  event upgrades a command entry; a command event never overwrites a hook. */
export type AgentSource = "hook" | "command";

export interface PaneAgent {
  agent: AgentName;
  phase: AgentPhase;
  source: AgentSource;
  /** How many background subagents are live in this pane right now (Claude Code
   *  `SubagentStart` seen, no matching `SubagentStop`). The main agent's `Stop`
   *  (→ `your-move`) fires while background subagents keep running, so a session
   *  would wrongly read "your move" mid-work; a positive count folds the pane's
   *  effective phase back to `working` (see effectivePhase). Bounded to a single
   *  turn (reset on UserPromptSubmit) and cleared on SessionEnd, so a missed
   *  SubagentStop can never leak a stuck spinner past the current turn. */
  liveSubagents?: number;
  /** Recorded from SessionStart — dashboard fuel for later plans. */
  sessionId?: string;
  transcriptPath?: string;
}

/** The phase a pane effectively presents, folding in live background subagents.
 *  `permission` still outranks everything (a blocked MAIN agent is more urgent
 *  than background work); otherwise a pane with any live subagent reads as
 *  `working` even if the main agent already ended its turn (`your-move`) or is
 *  idle. This is the single rule that keeps the sidebar's tumbling square up
 *  while subagents run — consumed by both sessionSignal (the indicator) and
 *  agentTracker (the session `working` fact) so the two never disagree. */
export function effectivePhase(pa: Pick<PaneAgent, "phase" | "liveSubagents">): AgentPhase {
  if (pa.phase === "permission") return "permission";
  if ((pa.liveSubagents ?? 0) > 0) return "working";
  return pa.phase;
}

interface AgentStoreState {
  panes: Record<PaneId, PaneAgent>;
  /** Canary (Plan 008 §5): flips true the first time ANY SessionStart arrives.
   *  If the hooks are installed but this stays false after a Claude Code launch,
   *  the settings toggle shows the "hooks not detected" warning. */
  sawSessionStart: boolean;
  setPaneAgent: (paneId: PaneId, agent: PaneAgent) => void;
  removePaneAgent: (paneId: PaneId) => void;
  /** Bump this pane's live-subagent count by `delta` (floored at 0). A positive
   *  delta for a pane with no entry yet (an out-of-order SubagentStart before
   *  its SessionStart) seeds the implied live Claude hook entry; a negative
   *  delta for an unknown pane is a no-op. Returns nothing — callers read the
   *  updated pane back to drive the session `working` fact. */
  adjustSubagents: (paneId: PaneId, delta: number) => void;
  markSessionStart: () => void;
  /** View-acknowledgment (mirrors activateSession's `unread = false`): a
   *  "your move" you've now seen calms back to idle. Permission is exempt —
   *  a still-blocked agent is still urgent, so it never acknowledges. */
  acknowledgeYourMove: (paneIds: PaneId[]) => void;
  /** Cadence-assisted exit from the blocked state (attentionTracker): the
   *  approval of a permission prompt fires no hook event until the turn ends,
   *  so sustained output while "permission" means the block is over. */
  demotePermissionToWorking: (paneId: PaneId) => void;
  reset: () => void;
}

export const useAgentStore = create<AgentStoreState>()(
  immer((set) => ({
    panes: {},
    sawSessionStart: false,
    setPaneAgent: (paneId, agent) =>
      set((s) => {
        s.panes[paneId] = agent;
      }),
    removePaneAgent: (paneId) =>
      set((s) => {
        delete s.panes[paneId];
      }),
    adjustSubagents: (paneId, delta) =>
      set((s) => {
        const pa = s.panes[paneId];
        if (pa) {
          pa.liveSubagents = Math.max(0, (pa.liveSubagents ?? 0) + delta);
        } else if (delta > 0) {
          // SubagentStart before we saw the main SessionStart (out of order or a
          // dropped line): a running subagent proves Claude is live here, so
          // seed the hook-owned entry it belongs to (phase idle; the count is
          // what makes it read as working).
          s.panes[paneId] = {
            agent: "claude",
            phase: "idle",
            source: "hook",
            liveSubagents: delta,
          };
        }
        // delta <= 0 with no entry: nothing to decrement — ignore.
      }),
    markSessionStart: () =>
      set((s) => {
        s.sawSessionStart = true;
      }),
    acknowledgeYourMove: (paneIds) =>
      set((s) => {
        for (const paneId of paneIds) {
          const pa = s.panes[paneId];
          if (pa?.phase === "your-move") pa.phase = "idle";
        }
      }),
    demotePermissionToWorking: (paneId) =>
      set((s) => {
        const pa = s.panes[paneId];
        if (pa?.phase === "permission") pa.phase = "working";
      }),
    reset: () =>
      set((s) => {
        s.panes = {};
        s.sawSessionStart = false;
      }),
  }))
);

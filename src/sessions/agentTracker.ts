// agentTracker — the per-pane state machine for hooked coding agents.
//
// Input: the Tauri `agent-event` (emitted by the Rust spool watcher, Plan 008
// §3), pinned contract:
//   { paneId, event: "SessionStart" | "UserPromptSubmit" | "Stop" |
//     "Notification" | "SessionEnd", kind?, sessionId?, transcriptPath?, cwd? }
//
// Output: writes the pane's phase into agentStore (what the sidebar renders)
// AND feeds attentionTracker's class-A tier (setAgentActive / noteAgentWorking)
// so, while an agent lives, the pane's working/needs-you truth comes from the
// agent — not the output-cadence guess. On SessionEnd the pane reverts to the
// heuristic tiers.
//
// Forward-compatibility (Plan 008 §3): unknown `event` and unknown Notification
// `kind` values are tolerated silently — the machine simply doesn't transition.
// Out-of-order events are tolerated too: any phase event marks the pane
// agent-owned, so an early UserPromptSubmit (before its SessionStart) still
// works; identity is filled in whenever SessionStart's fields arrive.

import { listen } from "@tauri-apps/api/event";

import { useAgentStore, type PaneAgent } from "@/store/agentStore";
import {
  useSessionsStore,
  findSessionForPane,
  isSessionVisible,
  getVisibleSessionIds,
  type SessionId,
} from "@/store/sessionsStore";
import { leaves as treeLeaves } from "@/store/layout/tree";
import {
  setAgentActive,
  noteAgentWorking,
  noteAgentPermission,
} from "@/sessions/attentionTracker";
import { onCommandEvent } from "@/sessions/commandTracker";
import { agentFromCommand } from "@/sessions/agentIdentity";
import { usePaneResumeStore } from "@/store/paneResumeStore";
import type { PaneId } from "@/types";

export interface AgentEvent {
  paneId: PaneId;
  event: string;
  kind?: string;
  sessionId?: string;
  transcriptPath?: string;
  cwd?: string;
}

/** The abstract transition an event implies. Pure over (event, kind) only —
 *  none of the transitions depend on the prior phase, which keeps out-of-order
 *  handling trivial. Exported for table tests. */
export type AgentTransition =
  | { type: "phase"; phase: PaneAgent["phase"] }
  | { type: "end" }
  | { type: "ignore" };

export function transitionFor(event: string, kind?: string): AgentTransition {
  switch (event) {
    case "SessionStart":
      return { type: "phase", phase: "idle" };
    case "UserPromptSubmit":
      return { type: "phase", phase: "working" };
    case "Stop":
      return { type: "phase", phase: "your-move" };
    case "SessionEnd":
      return { type: "end" };
    case "Notification":
      // permission_prompt is the money signal (blocked mid-turn); idle_prompt
      // collapses into "your move" per the locked Design. Any other kind is an
      // unknown notification we tolerate silently.
      if (kind === "permission_prompt") return { type: "phase", phase: "permission" };
      if (kind === "idle_prompt") return { type: "phase", phase: "your-move" };
      return { type: "ignore" };
    default:
      // Unknown event (version drift) — tolerate silently.
      return { type: "ignore" };
  }
}

/** Apply one agent-event to agentStore + attentionTracker's class-A tier. */
export function applyAgentEvent(evt: AgentEvent): void {
  const t = transitionFor(evt.event, evt.kind);
  if (t.type === "ignore") return;

  const store = useAgentStore.getState();

  if (t.type === "end") {
    store.removePaneAgent(evt.paneId);
    setAgentActive(evt.paneId, false); // revert this pane to the heuristic tiers
    // Plan 009: a clean SessionEnd means the agent shouldn't re-offer a resume
    // on next launch — keep the record but clear its alive flag.
    usePaneResumeStore.getState().markEnded(evt.paneId);
    return;
  }

  // Canary: the first SessionStart confirms the hooks actually fire.
  if (evt.event === "SessionStart") {
    store.markSessionStart();
    // Plan 009: remember this pane ran Claude, with its resume id + cwd, so a
    // restart can offer [Resume]. cwd prefers the hook's own value, falling back
    // to the owning session's folder.
    const cwd = evt.cwd ?? findSessionForPane(useSessionsStore.getState(), evt.paneId)?.folderPath ?? null;
    usePaneResumeStore
      .getState()
      .recordAgentStart(evt.paneId, { agentSessionId: evt.sessionId, cwd });
  }

  // View-acknowledgment, mirroring bumpUnread's "never light up the visible
  // session": a turn that completes while you're watching it needs no dot —
  // it lands as calm idle. Permission is exempt: a still-blocked agent is
  // still urgent whether or not you happen to be looking.
  let phase = t.phase;
  if (phase === "your-move" && paneSessionIsVisible(evt.paneId)) phase = "idle";

  const prev = store.panes[evt.paneId];
  const next: PaneAgent = {
    // These ARE Claude's hooks: always claude, always hook-sourced. A command-
    // derived identity for this pane is upgraded to the authoritative hook one.
    agent: "claude",
    phase,
    source: "hook",
    sessionId: evt.sessionId ?? prev?.sessionId,
    transcriptPath: evt.transcriptPath ?? prev?.transcriptPath,
  };
  store.setPaneAgent(evt.paneId, next);

  // Class A now owns this pane (idempotent): retires any pending cadence guess
  // and suppresses future cadence/133 noise for it.
  setAgentActive(evt.paneId, true);
  // Only "working" is an in-progress turn; permission/your-move/idle are not.
  noteAgentWorking(evt.paneId, phase === "working");
  // Keep the permission-exit output gate in sync with the phase.
  noteAgentPermission(evt.paneId, phase === "permission");
}

function paneSessionIsVisible(paneId: PaneId): boolean {
  const s = useSessionsStore.getState();
  const session = findSessionForPane(s, paneId);
  return session !== null && isSessionVisible(s, session.id);
}

// Hidden → visible acknowledgment: viewing a session calms its "your move"
// panes, the agent-phase mirror of activateSession's `unread = false`.
// Module-scope subscription so it holds for the app and for tests that drive
// applyAgentEvent directly; the empty-store early-out keeps it free when no
// hooked agent exists. `prevVisible` is reset by disposeAgentTracker.
let prevVisible: SessionId[] = [];
useSessionsStore.subscribe((s) => {
  const visible = getVisibleSessionIds(s);
  const newly = visible.filter((id) => !prevVisible.includes(id));
  prevVisible = visible;
  if (newly.length === 0) return;
  const ag = useAgentStore.getState();
  if (Object.keys(ag.panes).length === 0) return;
  const paneIds: PaneId[] = [];
  for (const sid of newly) {
    const root = s.sessions[sid]?.layoutRoot;
    if (root) paneIds.push(...treeLeaves(root));
  }
  if (paneIds.length > 0) ag.acknowledgeYourMove(paneIds);
});

/** Pane killed — drop its agent state and hand the pane back to heuristics.
 *  Called from the orchestrator's killPane alongside attentionTracker.forgetPane. */
export function forgetPaneAgent(paneId: PaneId): void {
  useAgentStore.getState().removePaneAgent(paneId);
  setAgentActive(paneId, false);
}

/** Command-derived (glyph-only) identity from a captured launch command.
 *  Called by the orchestrator when a pane's launch line finalizes. Registers
 *  identity ONLY when the pane has no entry yet — a hook entry (class A) is
 *  never clobbered, and a re-typed command never re-arms class A. Deliberately
 *  does NOT touch attentionTracker: the phase stays `idle` (no signal) so the
 *  output heuristics keep driving working/needs-you for these panes. */
export function noteCommandAgent(paneId: PaneId, command: string): void {
  const store = useAgentStore.getState();
  if (store.panes[paneId]) return; // never overwrite hook OR an earlier command
  const agent = agentFromCommand(command);
  if (agent === null) return;
  store.setPaneAgent(paneId, { agent, phase: "idle", source: "command" });
}

// Command lifecycle: a finished command drops ONLY command-derived identity —
// the process it named is gone. Hook entries are removed by SessionEnd /
// forgetPaneAgent, never here (a hooked Claude runs as one long command whose
// D mark may arrive before or after SessionEnd). Module-scope so it survives
// disposeAgentTracker like attentionTracker's own command subscription.
onCommandEvent((evt) => {
  if (evt.type !== "command-finished") return;
  const store = useAgentStore.getState();
  if (store.panes[evt.paneId]?.source === "command") store.removePaneAgent(evt.paneId);
});

/** Subscribe to the Rust `agent-event` stream. Call once at app boot; returns
 *  an unlistener. Errors wiring the listener are non-fatal (the feature simply
 *  stays dark and the heuristic tiers keep working). */
export function installAgentTracker(): () => void {
  let unlisten: (() => void) | undefined;
  let disposed = false;
  void listen<AgentEvent>("agent-event", (e) => applyAgentEvent(e.payload))
    .then((un) => {
      if (disposed) un();
      else unlisten = un;
    })
    .catch((err) => console.warn("agentTracker: listen failed", err));
  return () => {
    disposed = true;
    unlisten?.();
  };
}

/** Test/HMR reset — clears agent state. (attentionTracker's class-A sets are
 *  cleared by disposeAttentionTracker.) */
export function disposeAgentTracker(): void {
  useAgentStore.getState().reset();
  prevVisible = [];
}

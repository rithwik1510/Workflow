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

import { useAgentStore, effectivePhase, type PaneAgent } from "@/store/agentStore";
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
  | { type: "subagent"; delta: 1 | -1 }
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
    // Background subagent lifecycle: these do NOT move the MAIN agent's phase
    // (the main turn can be `your-move` while a background subagent runs on).
    // They only adjust the pane's live-subagent count, which effectivePhase
    // folds back into `working` — the fix for "Stop fires while subagents run".
    case "SubagentStart":
      return { type: "subagent", delta: 1 };
    case "SubagentStop":
      return { type: "subagent", delta: -1 };
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

  if (t.type === "subagent") {
    // A background subagent started/finished. Adjust the count (adjustSubagents
    // seeds the implied Claude entry on an out-of-order SubagentStart), then
    // recompute the pane's effective phase so the session's `working` fact
    // reflects "subagents still running" even after the main agent's Stop.
    store.adjustSubagents(evt.paneId, t.delta);
    // Re-read post-mutation: `store` is the pre-adjust getState() snapshot.
    const pa = useAgentStore.getState().panes[evt.paneId];
    if (!pa) return; // a stray SubagentStop for an unknown pane — nothing to do
    // The pane is now agent-owned (a subagent is a Claude hook signal); keep
    // cadence/133 suppressed for it exactly as any phase event would.
    setAgentActive(evt.paneId, true);
    noteAgentWorking(evt.paneId, effectivePhase(pa) === "working");
    return;
  }

  // Canary: the first SessionStart confirms the hooks actually fire.
  if (evt.event === "SessionStart") {
    store.markSessionStart();
    // Plan 009: remember this pane ran Claude (+ cwd) so a restart can offer
    // [Resume]. DELIBERATELY WITHOUT the session id: Claude Code only writes a
    // session's transcript once a message is actually sent, so a session that
    // starts and never converses has an id that resumes NOTHING ("No
    // conversation found") — and a pane's fresh empty session must not clobber
    // the id of the real conversation that ran there before it. The id is
    // recorded below, on the first evidence of content.
    const cwd = evt.cwd ?? findSessionForPane(useSessionsStore.getState(), evt.paneId)?.folderPath ?? null;
    usePaneResumeStore.getState().recordAgentStart(evt.paneId, { cwd });
  } else if (
    evt.sessionId &&
    (evt.event === "UserPromptSubmit" ||
      evt.event === "Stop" ||
      (evt.event === "Notification" && evt.kind === "permission_prompt"))
  ) {
    // First PROOF of a real conversation: a prompt was submitted, a turn
    // finished, or a turn is blocked on permission — all of which can only
    // happen once the transcript exists on disk, i.e. `claude --resume <id>`
    // will actually find it. Only now does the id become the pane's resume
    // target. (Notification/idle_prompt is excluded: it can fire on an empty
    // session sitting at its prompt.)
    usePaneResumeStore
      .getState()
      .recordAgentStart(evt.paneId, { agentSessionId: evt.sessionId, cwd: evt.cwd });
  }

  // View-acknowledgment, mirroring bumpUnread's "never light up the visible
  // session": a turn that completes while you're watching it needs no dot —
  // it lands as calm idle. Permission is exempt: a still-blocked agent is
  // still urgent whether or not you happen to be looking.
  let phase = t.phase;
  if (phase === "your-move" && paneSessionIsVisible(evt.paneId)) phase = "idle";

  const prev = store.panes[evt.paneId];
  // A new user turn (UserPromptSubmit) is a clean slate: reset the subagent
  // count so a missed SubagentStop can never leak a stuck spinner past the turn
  // it belonged to. Any other transition carries the count forward — crucially
  // Stop, which fires while background subagents are still live. (On the normal
  // auto-resume path the last SubagentStop drives the count to 0 BEFORE this
  // UserPromptSubmit, so the reset is a no-op there.)
  const liveSubagents = evt.event === "UserPromptSubmit" ? 0 : prev?.liveSubagents ?? 0;
  const next: PaneAgent = {
    // These ARE Claude's hooks: always claude, always hook-sourced. A command-
    // derived identity for this pane is upgraded to the authoritative hook one.
    agent: "claude",
    phase,
    source: "hook",
    liveSubagents,
    sessionId: evt.sessionId ?? prev?.sessionId,
    transcriptPath: evt.transcriptPath ?? prev?.transcriptPath,
  };
  store.setPaneAgent(evt.paneId, next);

  // Class A now owns this pane (idempotent): retires any pending cadence guess
  // and suppresses future cadence/133 noise for it.
  setAgentActive(evt.paneId, true);
  // The session is "working" whenever the MAIN turn is in progress OR a
  // background subagent is still live (effectivePhase folds the latter in), so
  // a premature Stop can't drop the spinner while subagents run.
  noteAgentWorking(evt.paneId, effectivePhase(next) === "working");
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

/** A command LUME ITSELF wrote to a pane: the startup-autorun replay, the
 *  resume banner's [Resume], and auto-resume. The input-capture wire
 *  deliberately never sees writePty traffic ("replaying a command never
 *  re-captures it"), so programmatic launches must be noted explicitly here —
 *  otherwise agent identity and resume memory silently skip them. That gap is
 *  why Codex (no hooks to compensate, unlike Claude) could resume exactly once
 *  and then never again: [Resume] cleared the record and nothing re-created it.
 *  Notes glyph identity AND refreshes the resume record; no-op for non-agent
 *  commands (an `npm run dev` autorun is not resume material). */
export function notePaneLaunch(paneId: PaneId, command: string, cwd: string | null): void {
  const agent = agentFromCommand(command);
  if (agent === null) return;
  noteCommandAgent(paneId, command);
  usePaneResumeStore
    .getState()
    .recordLaunchCommand(paneId, { agent, launchCommand: command, cwd });
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

// sessionSignal — the single place that ranks a session's sidebar signal, so
// SessionRow, SessionGroup's collapsed-header roll-up, and the StatusBar
// needs-you roll-up all agree (Plan 008 locked Design).
//
// Priority (most urgent first): permission > your-move (turn-complete/idle) >
// working > idle — today's "unread trumps working" generalized. The visible
// session NEVER signals (you can see the terminal), so it always resolves to
// "active" regardless of what its agents are doing.

import { leaves as treeLeaves } from "@/store/layout/tree";
import {
  getVisibleSessionIds,
  type Session,
  type SessionsState,
} from "@/store/sessionsStore";
import { effectivePhase, type AgentName, type AgentPhase, type PaneAgent } from "@/store/agentStore";
import type { PaneId } from "@/types";

/** The agent-derived part of a session's signal (class A). `null` = no live
 *  agent needs anything (idle or none) — the heuristic tiers show through. */
export type AgentSignal = "working" | "permission" | "your-move";

export interface SessionAgentView {
  /** Identity glyph fuel: every distinct agent living in this session, in
   *  pane-tree order (a session can run several side by side). Empty if none. */
  agents: AgentName[];
  /** Most-urgent agent signal across the session's panes, or null. */
  signal: AgentSignal | null;
  /** The agent of the most-urgent pane — feeds signalReason. Null if none. */
  signalAgent: AgentName | null;
}

const PHASE_RANK: Record<AgentPhase, number> = {
  permission: 3,
  "your-move": 2,
  working: 1,
  idle: 0,
};

/** Aggregate a session's panes into one agent view. `agents` lists each distinct
 *  agent in pane-tree order (shown as side-by-side glyphs once identity is
 *  known, even while idle); `signal` is the most-urgent non-idle phase, or null;
 *  `signalAgent` is the agent of that most-urgent pane. */
export function sessionAgentView(
  panes: Record<PaneId, PaneAgent>,
  session: Pick<Session, "layoutRoot">
): SessionAgentView {
  if (!session.layoutRoot) return { agents: [], signal: null, signalAgent: null };
  const agents: AgentName[] = [];
  // Rank by EFFECTIVE phase (folds live background subagents into `working`) so
  // a pane whose main agent already Stopped but still has subagents running
  // out-ranks its own `your-move` and keeps the session reading as working.
  let bestPhase: AgentPhase = "idle";
  let bestAgent: AgentName | null = null;
  for (const paneId of treeLeaves(session.layoutRoot)) {
    const pa = panes[paneId];
    if (!pa) continue;
    if (!agents.includes(pa.agent)) agents.push(pa.agent);
    const eff = effectivePhase(pa);
    if (bestAgent === null || PHASE_RANK[eff] > PHASE_RANK[bestPhase]) {
      bestPhase = eff;
      bestAgent = pa.agent;
    }
  }
  const signal: AgentSignal | null =
    bestAgent && bestPhase !== "idle" ? (bestPhase as AgentSignal) : null;
  return { agents, signal, signalAgent: bestAgent };
}

/** The final indicator a sidebar row/roll-up should render. */
export type SidebarSignal = "active" | "permission" | "your-move" | "working" | "idle";

/** Rank agent (class A) + heuristic (class B/C) inputs into one indicator.
 *  Visible sessions never signal. Agent signals outrank the heuristic flags. */
export function computeSessionSignal(input: {
  visible: boolean;
  unread: boolean;
  working: boolean;
  agentSignal: AgentSignal | null;
}): SidebarSignal {
  if (input.visible) return "active";
  if (input.agentSignal === "permission") return "permission";
  if (input.agentSignal === "your-move" || input.unread) return "your-move";
  if (input.agentSignal === "working" || input.working) return "working";
  return "idle";
}

/** The fleet needs-you roll-up: across ALL sessions, how many are blocked on a
 *  permission prompt vs. waiting for your move. The visible session(s) never
 *  signal (computeSessionSignal → "active"), so only background sessions count.
 *
 *  This is THE single source of truth for that count — the StatusBar chip and
 *  Plan 011's taskbar badge both call it, so the two can never disagree about
 *  how many sessions need you. Pure over its inputs (no store reads inside), so
 *  callers can memoize on exactly the slices it depends on. */
export interface NeedsYouCounts {
  /** Background sessions blocked on a permission prompt (the urgent tier). */
  permission: number;
  /** Background sessions waiting for your move (turn complete / idle / unread). */
  yourMove: number;
}

export function needsYouCounts(
  agentPanes: Record<PaneId, PaneAgent>,
  sessions: Iterable<Session>,
  visibility: Pick<SessionsState, "splitView" | "activeSessionId">
): NeedsYouCounts {
  const visible = getVisibleSessionIds(visibility);
  let permission = 0;
  let yourMove = 0;
  for (const sess of sessions) {
    const signal = computeSessionSignal({
      visible: visible.includes(sess.id),
      unread: sess.unread,
      working: sess.working,
      agentSignal: sessionAgentView(agentPanes, sess).signal,
    });
    if (signal === "permission") permission++;
    else if (signal === "your-move") yourMove++;
  }
  return { permission, yourMove };
}

/** Roll up several sessions' signals into the single most-urgent one for a
 *  collapsed group header (Plan 008: permission > turn-complete > working).
 *  `active`/`idle` sessions contribute nothing, so a collapsed folder shows a
 *  signal only when a hidden child actually needs attention. Returns null when
 *  nothing does. */
export function rollUpSignal(signals: SidebarSignal[]): SidebarSignal | null {
  let best: SidebarSignal | null = null;
  for (const s of signals) {
    if (s === "permission") return "permission"; // top rank — done
    if (s === "your-move") best = "your-move";
    else if (s === "working" && best !== "your-move") best = "working";
  }
  return best;
}

/** Human reason shown in tooltips / aria-labels for each signal. */
export function signalReason(signal: SidebarSignal, agent: AgentName | null): string {
  const who = agent ? agentLabel(agent) : "";
  switch (signal) {
    case "permission":
      return who ? `${who} — waiting on permission` : "waiting on permission";
    case "your-move":
      return who ? `${who} — turn complete` : "finished — needs you";
    case "working":
      return who ? `${who} — working` : "working";
    case "active":
      return "viewing";
    case "idle":
      return "idle";
  }
}

/** Muted glyph shown after the session name once the agent is identified.
 *  Claude/Gemini are the characters their own CLIs print; Codex has no
 *  Unicode mark, so the UI draws it (SignalIndicator's AgentGlyph) and "▌"
 *  (its TUI cursor) is only the plain-text fallback. Brand tints live in
 *  SessionRow.module.css. */
export const AGENT_GLYPH: Record<AgentName, string> = {
  claude: "✻",
  codex: "▌",
  gemini: "✦",
};

export function agentLabel(agent: AgentName): string {
  switch (agent) {
    case "claude":
      return "Claude";
    case "codex":
      return "Codex";
    case "gemini":
      return "Gemini";
  }
}

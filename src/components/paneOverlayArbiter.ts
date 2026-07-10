// paneOverlayArbiter — the ONE place that ranks the overlays contending for a
// pane's top-center slot (Plan 014 §7). Three overlays can want it:
//   1. PaneResumeBanner  — "✻ Claude was running here — [Resume] [Just shell]"
//   2. AttemptHintChip   — "Fresh worktree — run your install"
//   3. CoachChip (pane)  — a workflow rescue tip (lowest priority)
// PaneSearchBar is top-RIGHT and never contends here.
//
// Priority is resume → attempt-hint → coach. Keeping the eligibility rules in
// one pure function stops three copies of "who wins the slot" from drifting as
// the overlays evolve. The predicate the coach engine consults for gate 6
// (isCoachPaneSlotFree) is derived from the SAME ranking, so the coach can never
// displace a higher overlay.

import { useAgentStore } from "@/store/agentStore";
import { useAttemptStore } from "@/store/attemptStore";
import { usePaneResumeStore } from "@/store/paneResumeStore";
import { findSessionForPane, useSessionsStore } from "@/store/sessionsStore";
import type { PaneId } from "@/types";

/** Which overlay owns the slot, or null when nothing wants it. */
export type PaneOverlaySlot = "resume" | "attempt-hint" | "coach" | null;

export interface PaneOverlayInputs {
  /** A resume record survived shutdown and no live agent has re-registered —
   *  the exact condition PaneResumeBanner already renders on. */
  resumeEligible: boolean;
  /** An attempt hint exists and hasn't been dismissed. */
  attemptEligible: boolean;
  /** The coach has a live pane-anchored chip for this pane. Only meaningful
   *  when asking "should CoachChip show"; the gate-6 predicate passes true so
   *  the slot resolves to "coach" whenever nothing higher wants it. */
  coachEligible: boolean;
}

/** Rank the contenders. Pure — the callers pass in the store-derived booleans. */
export function paneOverlaySlot(i: PaneOverlayInputs): PaneOverlaySlot {
  if (i.resumeEligible) return "resume";
  if (i.attemptEligible) return "attempt-hint";
  if (i.coachEligible) return "coach";
  return null;
}

/**
 * Gate 6 predicate (Plan 014 §3): is the pane's top-center slot free for a coach
 * chip right now? Reads the stores imperatively — it runs inside tryPush, not in
 * a render. Wired into coachStore via setCoachPaneSlotFree from initCoach.
 */
export function isCoachPaneSlotFree(paneId: PaneId): boolean {
  const record = usePaneResumeStore.getState().records[paneId];
  const hasLiveAgent = !!useAgentStore.getState().panes[paneId];
  const resumeEligible = !!record && record.aliveAtShutdown && !hasLiveAgent;

  const session = findSessionForPane(useSessionsStore.getState(), paneId);
  const attempt = session ? useAttemptStore.getState().attempts[session.id] : undefined;
  const attemptEligible = !!attempt && !attempt.hintDismissed;

  return paneOverlaySlot({ resumeEligible, attemptEligible, coachEligible: true }) === "coach";
}

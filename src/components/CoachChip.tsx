// CoachChip — the live "push" surface of the workflow coach (Plan 014 §7). It
// renders coachStore.activeTip, and ONE component covers both anchor kinds:
//
//   - paneId passed  → the pane-anchored renderer (selection rescue). Overlay
//     grammar copied from PaneResumeBanner: absolutely positioned so it never
//     reflows the xterm grid, presence in/out, never steals focus. It is the
//     LOWEST-priority occupant of the pane's top-center slot — paneOverlayArbiter
//     hides it the instant a resume banner or attempt hint wants the slot.
//   - no paneId      → the session-pair renderer (session thrash). Mounted once
//     in App. Per the plan's Risks fallback, it anchors to the sidebar region
//     (fixed, top-left) and names the observed pair in its copy, rather than
//     tracking two scrolling/collapsing sidebar rows — same message, robust
//     geometry.
//
// Auto-fade: the OWNING instance (the one whose anchor matches activeTip) clears
// the tip after COACH_TUNING.autoFadeMs. Auto-fade is "not now" — the showing
// already counted in tryPush, so this is a bare clearActiveTip with no penalty.
// "Don't suggest this" is the explicit control: dismissForever (+ 7-day global
// quiet). There is no bare ×.

import { useEffect } from "react";

import styles from "@/components/CoachChip.module.css";
import { paneOverlaySlot } from "@/components/paneOverlayArbiter";
import { usePresence } from "@/hooks/usePresence";
import { TIP_CATALOG, COACH_TUNING, type TipId } from "@/sessions/coachCatalog";
import { useAgentStore } from "@/store/agentStore";
import { useAttemptStore } from "@/store/attemptStore";
import { useCoachStore } from "@/store/coachStore";
import { usePaneResumeStore } from "@/store/paneResumeStore";
import { findSessionForPane, useSessionsStore } from "@/store/sessionsStore";
import type { PaneId } from "@/types";

/** Shared chip body — copy line, optional keycaps, and the explicit dismissal.
 *  `context` is an optional secondary line (the pair names for thrash). */
function ChipBody({
  tipId,
  context,
  state,
  variant,
}: {
  tipId: TipId;
  context?: string;
  state: "open" | "closed";
  variant: "pane" | "pair";
}) {
  const def = TIP_CATALOG[tipId];
  const dismissForever = useCoachStore((s) => s.dismissForever);
  return (
    <div
      className={`${styles.chip} ${variant === "pair" ? styles.pair : ""}`}
      data-state={state}
      role="status"
      // Never pull focus away from the terminal/work surface.
      tabIndex={-1}
    >
      <span className={styles.body}>
        {context && <span className={styles.context}>{context}</span>}
        <span className={styles.copy}>{def.copy}</span>
      </span>
      {def.keycaps && def.keycaps.length > 0 && (
        <span className={styles.keys}>
          {def.keycaps.map((k, i) => (
            <kbd key={`${tipId}-${i}`} className={styles.key}>
              {k}
            </kbd>
          ))}
        </span>
      )}
      <button
        type="button"
        className={styles.dismiss}
        onClick={() => dismissForever(tipId)}
        title="Don't suggest this — and pause tips for a week"
      >
        Don&rsquo;t suggest this
      </button>
    </div>
  );
}

/** Owner-only auto-fade: schedule a single clearActiveTip per showing. Keyed on
 *  shownAt so re-pushes (a new showing) restart the timer; unmount clears it. */
function useAutoFade(owns: boolean, shownAt: number | undefined): void {
  const clearActiveTip = useCoachStore((s) => s.clearActiveTip);
  useEffect(() => {
    if (!owns || shownAt === undefined) return;
    const t = window.setTimeout(() => clearActiveTip(), COACH_TUNING.autoFadeMs);
    return () => window.clearTimeout(t);
  }, [owns, shownAt, clearActiveTip]);
}

/** Pane-anchored renderer (selection rescue). */
function PaneCoachChip({ paneId }: { paneId: PaneId }) {
  const activeTip = useCoachStore((s) => s.activeTip);
  const owns = activeTip?.anchor.kind === "pane" && activeTip.anchor.paneId === paneId;

  // Reactive slot arbitration: yield to a resume banner / attempt hint that
  // appears AFTER the push (gate 6 only checked the slot at push time).
  const record = usePaneResumeStore((s) => s.records[paneId]);
  const hasLiveAgent = useAgentStore((s) => !!s.panes[paneId]);
  const sessionId = useSessionsStore((s) => findSessionForPane(s, paneId)?.id ?? null);
  const attempt = useAttemptStore((s) => (sessionId ? s.attempts[sessionId] : undefined));
  const resumeEligible = !!record && record.aliveAtShutdown && !hasLiveAgent;
  const attemptEligible = !!attempt && !attempt.hintDismissed;
  const slotFree =
    paneOverlaySlot({ resumeEligible, attemptEligible, coachEligible: true }) === "coach";

  useAutoFade(owns, owns ? activeTip?.shownAt : undefined);

  const shouldShow = owns && slotFree;
  const { mounted, state } = usePresence(shouldShow, 200);
  if (!mounted || !activeTip || activeTip.anchor.kind !== "pane") return null;

  return <ChipBody tipId={activeTip.tipId} state={state} variant="pane" />;
}

/** Session-pair renderer (session thrash). Fallback geometry: anchored to the
 *  sidebar region with the pair named in the copy (see file header). */
function PairCoachChip() {
  const activeTip = useCoachStore((s) => s.activeTip);
  const owns = activeTip?.anchor.kind === "session-pair";

  useAutoFade(owns, owns ? activeTip?.shownAt : undefined);

  const { mounted, state } = usePresence(owns, 200);
  if (!mounted || !activeTip || activeTip.anchor.kind !== "session-pair") return null;

  const left = activeTip.payload?.left;
  const right = activeTip.payload?.right;
  const context = left && right ? `${left} ⇄ ${right}` : undefined;

  return (
    <div className={styles.pairMount}>
      <ChipBody tipId={activeTip.tipId} context={context} state={state} variant="pair" />
    </div>
  );
}

export function CoachChip({ paneId }: { paneId?: PaneId }) {
  return paneId !== undefined ? <PaneCoachChip paneId={paneId} /> : <PairCoachChip />;
}

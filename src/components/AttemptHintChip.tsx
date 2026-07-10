// AttemptHintChip — the one-time "fresh worktree" reminder pinned in an attempt
// session's pane (Plan 013 Phase A). A worktree does NOT share node_modules with
// the repo it forked, so a brand-new attempt needs its own install before an
// agent can do anything useful. Lume NEVER runs that install (product boundary:
// it forks the folder and steps back) — it just shows this chip once:
//
//   Fresh worktree — run your project's install before starting an agent
//                                              · [Open folder] [Dismiss]
//
// Styled after PaneResumeBanner: an OVERLAY (never in flow, so it can't reflow
// the xterm grid) that slides in and honours reduced-motion via usePresence.
// Keyed off attemptStore by the pane's owning session; [Dismiss] persists so it
// never returns for this attempt.

import styles from "@/components/AttemptHintChip.module.css";
import { paneOverlaySlot } from "@/components/paneOverlayArbiter";
import { usePresence } from "@/hooks/usePresence";
import { revealInExplorer } from "@/lib/revealInExplorer";
import { useAgentStore } from "@/store/agentStore";
import { useAttemptStore } from "@/store/attemptStore";
import { usePaneResumeStore } from "@/store/paneResumeStore";
import { findSessionForPane, useSessionsStore } from "@/store/sessionsStore";
import type { PaneId } from "@/types";

export function AttemptHintChip({ paneId }: { paneId: PaneId }) {
  // Attempts are keyed by session id, so map this pane to its owning session.
  // The id is a stable string, safe to subscribe to directly.
  const sessionId = useSessionsStore((s) => findSessionForPane(s, paneId)?.id ?? null);
  const attempt = useAttemptStore((s) => (sessionId ? s.attempts[sessionId] : undefined));
  const dismissHint = useAttemptStore((s) => s.dismissHint);

  // Yield to the resume banner: both overlays pin to the same top-center slot,
  // and after a restart an attempt pane can have BOTH an undismissed hint and a
  // resumable agent. The banner is the actionable one (Resume/Just shell); the
  // hint is persistent until dismissed, so it simply reappears once the banner
  // resolves. Ranking lives in paneOverlayArbiter (resume → attempt-hint →
  // coach), shared with PaneResumeBanner and CoachChip so the rules can't drift.
  const hasResumableAgent = usePaneResumeStore(
    (s) => s.records[paneId]?.aliveAtShutdown ?? false
  );
  const hasLiveAgent = useAgentStore((s) => !!s.panes[paneId]);
  const resumeEligible = hasResumableAgent && !hasLiveAgent;
  const attemptEligible = !!attempt && !attempt.hintDismissed;

  const shouldShow =
    paneOverlaySlot({ resumeEligible, attemptEligible, coachEligible: false }) === "attempt-hint";
  const { mounted, state } = usePresence(shouldShow, 200);
  if (!mounted || !attempt || !sessionId) return null;

  return (
    <div className={styles.chip} data-state={state} role="status">
      <span className={styles.label}>
        Fresh worktree — run your project&rsquo;s install before starting an agent
      </span>
      <span className={styles.actions}>
        <button
          type="button"
          className={styles.btn}
          onClick={() => void revealInExplorer(attempt.worktreePath)}
          title={attempt.worktreePath}
        >
          Open folder
        </button>
        <button type="button" className={styles.btn} onClick={() => dismissHint(sessionId)}>
          Dismiss
        </button>
      </span>
    </div>
  );
}

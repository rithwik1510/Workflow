// LandMenu — the Diff-tab "Land…" dropdown for an attempt session (Plan 013
// Phase B). Offers only the paths that APPLY (a PR when a remote + gh exist, a
// compare page when only a GitHub remote does), plus a local merge that is shown
// disabled WITH ITS REASON when it isn't provably safe, and a Clean up flow.
//
// The chrome is deliberately indistinguishable from the rest of the Diff header:
// the app's popover language (SplitMenu / NewAttemptPopover), var() fallbacks on
// every custom property, a scale+fade presence via usePresence (reduced-motion
// safe through the app-wide rule), and the accent used exactly ONCE — on the
// primary land action. Refusal reasons are quiet muted text, never alarms.

import { useEffect, useRef, useState } from "react";

import styles from "@/components/LandMenu.module.css";
import { IconGitBranch, IconGlobe, IconTrash } from "@/components/icons";
import { usePresence } from "@/hooks/usePresence";
import {
  gitRepoState,
  gitHasRemote,
  ghAvailable,
  type RepoState,
} from "@/lib/gitClient";
import {
  decideLandPaths,
  isGitHubRemote,
  createPrForAttempt,
  openCompareForAttempt,
  mergeAttemptLocally,
  cleanupAttempt,
  type LandPaths,
} from "@/sessions/attemptLand";
import type { Attempt } from "@/store/attemptStore";
import type { SessionId } from "@/store/sessionsStore";

// `gh --version` is invariant for an app run — probe once and reuse. (The Rust
// side still spawns per call, so caching here is the "cache per app run" the
// plan asks for.)
let ghCache: boolean | null = null;
async function ghAvailableCached(): Promise<boolean> {
  if (ghCache !== null) return ghCache;
  ghCache = await ghAvailable().catch(() => false);
  return ghCache;
}

/** Test seam: reset the per-run gh probe cache. */
export function __resetGhCache(): void {
  ghCache = null;
}

export function LandMenu({
  open,
  attempt,
  sessionId,
  onClose,
}: {
  open: boolean;
  attempt: Attempt;
  sessionId: SessionId;
  onClose: () => void;
}) {
  const { mounted, state } = usePresence(open, 120);
  if (!mounted) return null;
  return (
    <Panel
      key={sessionId}
      attempt={attempt}
      sessionId={sessionId}
      dataState={state}
      onClose={onClose}
    />
  );
}

function Panel({
  attempt,
  sessionId,
  dataState,
  onClose,
}: {
  attempt: Attempt;
  sessionId: SessionId;
  dataState: "open" | "closed";
  onClose: () => void;
}) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const [decision, setDecision] = useState<LandPaths | null>(null);
  const [remoteUrl, setRemoteUrl] = useState<string | null>(null);

  // Resolve the live land context (main-repo state, remote, gh) on open. Each
  // probe degrades to its safe default so a git hiccup can't wedge the menu.
  useEffect(() => {
    let alive = true;
    void (async () => {
      const [repoState, remote, gh]: [RepoState, string | null, boolean] = await Promise.all([
        gitRepoState(attempt.repoRoot).catch(() => ({
          currentBranch: null,
          clean: false,
        })),
        gitHasRemote(attempt.repoRoot).catch(() => null),
        ghAvailableCached(),
      ]);
      if (!alive) return;
      setRemoteUrl(remote);
      setDecision(
        decideLandPaths({
          hasRemote: !!remote,
          isGitHubRemote: isGitHubRemote(remote),
          ghAvailable: gh,
          repoState,
          baseBranch: attempt.baseBranch,
        })
      );
    })();
    return () => {
      alive = false;
    };
  }, [attempt.repoRoot, attempt.baseBranch]);

  // Esc + click-outside close. Capture phase for Esc so it wins over xterm.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    };
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node | null;
      if (panelRef.current && target && !panelRef.current.contains(target)) onClose();
    };
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("mousedown", onDown);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("mousedown", onDown);
    };
  }, [onClose]);

  // Each action closes the menu FIRST (so confirms/toasts aren't stacked behind
  // it), then runs its flow. The flows own their own success/error surfacing.
  const runPr = () => {
    onClose();
    void createPrForAttempt(attempt);
  };
  const runCompare = () => {
    onClose();
    if (remoteUrl) void openCompareForAttempt(attempt, remoteUrl);
  };
  const runMerge = () => {
    onClose();
    void mergeAttemptLocally(sessionId, attempt);
  };
  const runCleanup = () => {
    onClose();
    void cleanupAttempt(sessionId, attempt);
  };

  return (
    <div
      ref={panelRef}
      className={styles.menu}
      data-state={dataState}
      role="menu"
      aria-label="Land attempt"
    >
      {decision === null ? (
        <div className={styles.loading}>Checking…</div>
      ) : (
        <>
          {decision.createPr.show && (
            <button type="button" className={`${styles.item} ${styles.primary}`} role="menuitem" onClick={runPr}>
              <IconGlobe size={14} />
              <span className={styles.itemLabel}>Create pull request</span>
            </button>
          )}

          {decision.openCompare.show && (
            <button type="button" className={styles.item} role="menuitem" onClick={runCompare}>
              <IconGlobe size={14} />
              <span className={styles.itemLabel}>Open compare page</span>
            </button>
          )}

          {/* Local merge is never hidden — it's shown disabled with its reason so
              the refusal is legible (the reason IS the feature). */}
          <button
            type="button"
            className={styles.item}
            role="menuitem"
            disabled={!decision.localMerge.enabled}
            aria-disabled={!decision.localMerge.enabled}
            title={decision.localMerge.reason ?? undefined}
            onClick={decision.localMerge.enabled ? runMerge : undefined}
          >
            <IconGitBranch size={14} />
            <span className={styles.itemBody}>
              <span className={styles.itemLabel}>Merge into {attempt.baseBranch} locally</span>
              {decision.localMerge.reason && (
                <span className={styles.itemReason}>{decision.localMerge.reason}</span>
              )}
            </span>
          </button>

          <div className={styles.divider} role="separator" />

          <button type="button" className={styles.item} role="menuitem" onClick={runCleanup}>
            <IconTrash size={14} />
            <span className={styles.itemLabel}>Clean up…</span>
          </button>
        </>
      )}
    </div>
  );
}

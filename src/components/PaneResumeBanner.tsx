// PaneResumeBanner — the slim overlay chip that offers to bring an agent back
// (Plan 009). It appears on RESTORE: a pane whose resume record survived the
// last app close (aliveAtShutdown) but which has no live agent yet gets a chip
//   ✻ Claude was running here — [Resume] [Just shell]
// pinned at the top of the terminal. [Resume] writes the EXACT resume command
// (the same string shown in the tooltip) to the pty; [Just shell] forgets it.
//
// PRODUCT BOUNDARY: this only ever writes the resume command resumeCommandFor()
// produced — verbatim, plus a carriage return. It never composes a prompt and
// never talks to a running agent.
//
// Visibility is derived, not stored: the moment a live agent registers for this
// pane (agentStore gets an entry — the resume actually took), the banner hides;
// clicking either button clears the record, which also hides it. So there is no
// dismissed flag to persist.

import { useEffect, useState } from "react";

import styles from "@/components/PaneResumeBanner.module.css";
import sessionRow from "@/components/SessionRow.module.css";
import { AgentGlyph } from "@/components/SignalIndicator";
import { usePresence } from "@/hooks/usePresence";
import { useAgentStore, type AgentName } from "@/store/agentStore";
import { usePaneResumeStore } from "@/store/paneResumeStore";
import { resumeCommandFor } from "@/sessions/agentResume";
import { agentLabel } from "@/sessions/sessionSignal";
import { dirExists } from "@/lib/fsClient";
import { writePty } from "@/terminals/ptyClient";
import type { PaneId } from "@/types";

const GLYPH_TINT: Record<AgentName, string> = {
  claude: sessionRow.glyphClaude,
  codex: sessionRow.glyphCodex,
  gemini: sessionRow.glyphGemini,
};

export function PaneResumeBanner({ paneId }: { paneId: PaneId }) {
  const record = usePaneResumeStore((s) => s.records[paneId]);
  const clearRecord = usePaneResumeStore((s) => s.clearRecord);
  // A live agent for this pane means the resume already took (or the user
  // launched one by hand) — nothing to offer.
  const hasLiveAgent = useAgentStore((s) => !!s.panes[paneId]);

  const shouldShow = !!record && record.aliveAtShutdown && !hasLiveAgent;
  const { mounted, state } = usePresence(shouldShow, 200);

  // Verify the recorded cwd still exists (Plan 009). Missing folder → warn and
  // disable Resume rather than drop the user into a resume that can't work.
  const [cwdMissing, setCwdMissing] = useState(false);
  const cwd = record?.cwd ?? null;
  useEffect(() => {
    let alive = true;
    if (!cwd) {
      setCwdMissing(false);
      return;
    }
    void dirExists(cwd).then((ok) => {
      if (alive) setCwdMissing(!ok);
    });
    return () => {
      alive = false;
    };
  }, [cwd]);

  if (!mounted || !record) return null;

  const resumeCmd = resumeCommandFor(record);
  const who = agentLabel(record.agent);
  // Tooltip shows the exact command that will run; the original launch flags are
  // surfaced for context but NEVER merged into the resume command.
  const tooltip =
    record.launchCommand && record.launchCommand !== resumeCmd
      ? `Runs: ${resumeCmd}\nLaunched as: ${record.launchCommand}`
      : `Runs: ${resumeCmd}`;

  const onResume = () => {
    if (cwdMissing) return;
    // The pane is a live shell sitting at its prompt — write the command the
    // user just saw, verbatim, and let them watch it run. Then forget the
    // record; if the resume takes, a live agent would have hidden us anyway.
    void writePty(paneId, `${resumeCmd}\r`).catch(() => undefined);
    clearRecord(paneId);
  };

  const onJustShell = () => clearRecord(paneId);

  return (
    <div className={styles.chip} data-state={state} role="status">
      <span className={`${styles.glyph} ${GLYPH_TINT[record.agent] ?? ""}`}>
        <AgentGlyph agent={record.agent} />
      </span>
      <span className={styles.label}>{who} was running here</span>
      {cwdMissing && <span className={styles.warn}>folder missing</span>}
      <span className={styles.actions}>
        <button
          type="button"
          className={`${styles.btn} ${styles.resume}`}
          title={cwdMissing ? "The folder this agent ran in no longer exists" : tooltip}
          disabled={cwdMissing}
          onClick={onResume}
        >
          Resume
        </button>
        <button type="button" className={styles.btn} onClick={onJustShell}>
          Just shell
        </button>
      </span>
    </div>
  );
}

// SessionRow — one session inside a SessionGroup. Spec §6.3.

import { useMemo, useState, type MouseEvent as ReactMouseEvent } from "react";
import styles from "@/components/SessionRow.module.css";
import {
  useSessionsStore,
  groupOf,
  isSessionVisible,
  type Session,
} from "@/store/sessionsStore";
import { useConfirmStore } from "@/store/confirmStore";
import { useContextMenuStore } from "@/store/contextMenuStore";
import { useAgentStore, type AgentName } from "@/store/agentStore";
import {
  sessionAgentView,
  computeSessionSignal,
  signalReason,
  agentLabel,
} from "@/sessions/sessionSignal";
import { revealInExplorer } from "@/lib/revealInExplorer";
import { useAttemptPopoverStore } from "@/store/attemptPopoverStore";
import { beginInternalSessionDrag } from "@/lib/internalSessionDrag";
import { InlineRename } from "@/components/InlineRename";
import { SignalIndicator, AgentGlyph } from "@/components/SignalIndicator";
import { IconTrash } from "@/components/icons";

interface Props {
  session: Session;
}

/** Per-agent brand tint (SessionRow.module.css). Desaturated on purpose — the
 *  accent stays the only loud colour in the list. */
const GLYPH_TINT: Record<AgentName, string> = {
  claude: styles.glyphClaude,
  codex: styles.glyphCodex,
  gemini: styles.glyphGemini,
};

export function SessionRow({ session }: Props) {
  const activeId = useSessionsStore((s) => s.activeSessionId);
  const enter = useSessionsStore((s) => s.enterSession);
  const ungroup = useSessionsStore((s) => s.ungroupSession);
  const purge = useSessionsStore((s) => s.purgeSession);
  const rename = useSessionsStore((s) => s.renameSession);
  const splitGroups = useSessionsStore((s) => s.splitGroups);
  const visible = useSessionsStore((s) => isSessionVisible(s, session.id));
  const inSplit = useSessionsStore((s) => s.splitView?.includes(session.id) ?? false);
  const isActive = session.id === activeId;
  // Part of a durable split group? (drives the Ungroup menu item.) Visible in
  // the split that's open right now? (faint highlight on the non-focused slot
  // so it reads as on-screen even though the keyboard ring is on its partner.)
  const grouped = groupOf(splitGroups, session.id) !== null;
  const [renaming, setRenaming] = useState(false);

  // Class A (Plan 008): a live hooked agent in this session speaks its exact
  // state. sessionAgentView aggregates the session's panes; computeSessionSignal
  // ranks it against the heuristic working/unread flags. The visible session
  // never signals (you can see the terminal), so it resolves to "active".
  const agentPanes = useAgentStore((s) => s.panes);
  const agentView = useMemo(
    () => sessionAgentView(agentPanes, session),
    [agentPanes, session]
  );
  const signal = computeSessionSignal({
    visible,
    unread: session.unread,
    working: session.working,
    agentSignal: agentView.signal,
  });

  // Indicator grammar (SessionRow.module.css documents the shape/saturation
  // rules this EXTENDS): working = tumbling logo square; permission = hollow
  // accent ring with the animated glow pulse (the urgent state is the one that
  // moves); your-move = solid accent dot with a STATIC glow; idle = hollow
  // grey; active (the session you're viewing) = neutral filled dot.
  // signalReason names the agent of the MOST-URGENT pane (signalAgent), which
  // is the one the row's colour/shape signal is about.
  const reason = signalReason(signal, agentView.signalAgent);
  // The state name rides on the row's aria-label so the signal isn't
  // colour/shape-only; the indicator itself stays aria-hidden (decorative).
  const rowAriaLabel =
    signal === "active" || signal === "idle" ? session.name : `${session.name} — ${reason}`;

  const onClick = () => {
    if (renaming) return;
    // Group-aware: a grouped row re-opens its split; an ungrouped one just
    // activates. enterSession handles both.
    enter(session.id);
  };

  // Drag the row onto the main area to view this session beside the active one.
  // Pointer-based (not HTML5 DnD) for the Tauri/WebView2 reason documented in
  // internalSessionDrag.ts. A sub-threshold movement falls through to onClick.
  const onMouseDown = (e: ReactMouseEvent<HTMLDivElement>) => {
    if (e.button !== 0 || renaming) return;
    beginInternalSessionDrag(session.id, session.name, e.clientX, e.clientY);
  };

  const onTrash = async (e: ReactMouseEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    const ok = await useConfirmStore.getState().confirm({
      title: "Delete session?",
      message: `Delete session "${session.name}"? This cannot be undone.`,
      confirmLabel: "Delete",
      danger: true,
    });
    if (ok) purge(session.id);
  };

  const onDoubleClick = (e: ReactMouseEvent<HTMLSpanElement>) => {
    e.stopPropagation();
    setRenaming(true);
  };

  const onContextMenu = (e: ReactMouseEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    useContextMenuStore.getState().openMenu(e.clientX, e.clientY, [
      { label: "Rename", onClick: () => setRenaming(true) },
      // Fork this session's repo into an isolated worktree (Plan 013). The
      // popover resolves the repo root from the folder itself.
      {
        label: "New attempt…",
        onClick: () =>
          useAttemptPopoverStore.getState().show(e.clientX, e.clientY, session.folderPath),
      },
      { label: "Reveal in Explorer", onClick: () => void revealInExplorer(session.folderPath) },
      // Only meaningful when this session is half of a durable split pair.
      ...(grouped ? [{ label: "Ungroup split", onClick: () => ungroup(session.id) }] : []),
      {
        label: "Delete",
        onClick: async () => {
          const ok = await useConfirmStore.getState().confirm({
            title: "Delete session?",
            message: `Delete session "${session.name}"? This cannot be undone.`,
            confirmLabel: "Delete",
            danger: true,
          });
          if (ok) purge(session.id);
        },
      },
    ]);
  };

  return (
    <div
      className={`${styles.row} ${isActive ? styles.active : ""} ${
        inSplit && !isActive ? styles.inSplit : ""
      }`}
      data-session-id={session.id}
      title={session.name}
      aria-label={rowAriaLabel}
      onClick={onClick}
      onMouseDown={onMouseDown}
      onContextMenu={onContextMenu}
    >
      {/* Fixed-size slot so every state (circle dots, working box) occupies
        * identical space — the label never shifts when the state changes and
        * the indicator stays optically centred against the session name. */}
      <SignalIndicator
        signal={signal}
        title={signal === "active" || signal === "idle" ? undefined : reason}
      />
      {renaming ? (
        <InlineRename
          initial={session.name}
          onCommit={(value) => {
            rename(session.id, value);
            setRenaming(false);
          }}
          onCancel={() => setRenaming(false)}
        />
      ) : (
        <span className={styles.nameWrap}>
          {/* Keyed by name: a rename (manual or the legacy "New session" →
           * "Session N" migration) remounts the span, replaying the short
           * fade/slide-in so the new name visibly "arrives". */}
          <span key={session.name} className={styles.name} onDoubleClick={onDoubleClick}>
            {session.name}
          </span>
          {/* Agent identity glyphs (Plan 008): one muted, brand-tinted glyph per
           * agent living here, side by side. Answers "which agents live here";
           * the left indicator keeps all attention colour/motion. */}
          {agentView.agents.map((agent) => (
            <span
              key={agent}
              className={`${styles.glyph} ${GLYPH_TINT[agent]}`}
              aria-hidden="true"
              title={agentLabel(agent)}
            >
              <AgentGlyph agent={agent} />
            </span>
          ))}
        </span>
      )}
      <button
        className={styles.trash}
        onMouseDown={(e) => e.stopPropagation()}
        onClick={(e) => void onTrash(e)}
        title="Delete session"
        aria-label="Delete session"
      >
        <IconTrash size={18} />
      </button>
    </div>
  );
}

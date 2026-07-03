// SessionGroup — header + nested session rows. See spec §6.2.
//
// Phase 3b: caret toggles collapsed state; `+` creates a session in this folder.
// Phase 3c.3: double-click label to rename group (empty commit reverts to basename).

import { useMemo, useState, type MouseEvent as ReactMouseEvent } from "react";
import styles from "@/components/SessionGroup.module.css";
import { SessionRow } from "@/components/SessionRow";
import { SplitPair } from "@/components/SplitPair";
import { SignalIndicator } from "@/components/SignalIndicator";
import {
  useSessionsStore,
  isSessionVisible,
  type SidebarFolderView,
} from "@/store/sessionsStore";
import { useAgentStore } from "@/store/agentStore";
import {
  sessionAgentView,
  computeSessionSignal,
  rollUpSignal,
  signalReason,
} from "@/sessions/sessionSignal";
import { createAndActivateSession } from "@/lib/sessions/sessionEntryFlows";
import { InlineRename } from "@/components/InlineRename";
import { IconChevron, IconPlus } from "@/components/icons";
import { useContextMenuStore } from "@/store/contextMenuStore";
import { useConfirmStore } from "@/store/confirmStore";
import { useAttemptPopoverStore } from "@/store/attemptPopoverStore";
import { revealInExplorer } from "@/lib/revealInExplorer";

interface Props {
  group: SidebarFolderView;
}

export function SessionGroup({ group }: Props) {
  const toggle = useSessionsStore((s) => s.toggleGroupCollapsed);
  const setLabel = useSessionsStore((s) => s.setGroupLabel);
  const purgeGroup = useSessionsStore((s) => s.purgeGroup);
  const [renaming, setRenaming] = useState(false);

  // Collapsed-header roll-up (Plan 008): nothing needing you is ever hidden.
  // A collapsed folder inherits its most-urgent child signal; expanded folders
  // show nothing (the child rows carry their own indicators).
  const agentPanes = useAgentStore((s) => s.panes);
  const splitView = useSessionsStore((s) => s.splitView);
  const activeSessionId = useSessionsStore((s) => s.activeSessionId);
  const rollUp = useMemo(() => {
    if (!group.collapsed) return null;
    const vis = { splitView, activeSessionId };
    const signals = group.sessions.map((s) =>
      computeSessionSignal({
        visible: isSessionVisible(vis, s.id),
        unread: s.unread,
        working: s.working,
        agentSignal: sessionAgentView(agentPanes, s).signal,
      })
    );
    return rollUpSignal(signals);
  }, [group.collapsed, group.sessions, agentPanes, splitView, activeSessionId]);

  const onHeaderClick = () => {
    if (renaming) return;
    toggle(group.folderPath);
  };

  const onAddClick = (e: ReactMouseEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    createAndActivateSession(group.folderPath);
  };

  const onLabelDoubleClick = (e: ReactMouseEvent<HTMLSpanElement>) => {
    e.stopPropagation();
    setRenaming(true);
  };

  const onContextMenu = (e: ReactMouseEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    useContextMenuStore.getState().openMenu(e.clientX, e.clientY, [
      { label: "Rename group", onClick: () => setRenaming(true) },
      // Fork this project into an isolated worktree (Plan 013). The popover
      // resolves the repo root from the group's folder.
      {
        label: "New attempt…",
        onClick: () =>
          useAttemptPopoverStore.getState().show(e.clientX, e.clientY, group.folderPath),
      },
      { label: "Reveal in Explorer", onClick: () => void revealInExplorer(group.folderPath) },
      { label: group.collapsed ? "Expand" : "Collapse", onClick: () => toggle(group.folderPath) },
      {
        label: "Delete group",
        onClick: async () => {
          const ok = await useConfirmStore.getState().confirm({
            title: "Delete group?",
            message: `Delete group "${group.label}" and all ${group.sessions.length} session(s)? This cannot be undone.`,
            confirmLabel: "Delete all",
            danger: true,
          });
          if (ok) purgeGroup(group.folderPath);
        },
      },
    ]);
  };

  return (
    <div className={styles.group} data-folder={group.folderPath}>
      <div className={styles.header} onClick={onHeaderClick} onContextMenu={onContextMenu} title={group.folderPath}>
        <span className={`${styles.caret} ${group.collapsed ? styles.caretCollapsed : ""}`}>
          <IconChevron size={12} />
        </span>
        {renaming ? (
          <InlineRename
            initial={group.label}
            onCommit={(value) => {
              setLabel(group.folderPath, value);
              setRenaming(false);
            }}
            onCancel={() => setRenaming(false)}
          />
        ) : (
          <span className={styles.label} onDoubleClick={onLabelDoubleClick}>
            {group.label}
          </span>
        )}
        {rollUp && (
          <span className={styles.rollup}>
            <SignalIndicator signal={rollUp} title={signalReason(rollUp, null)} />
          </span>
        )}
        <button
          className={styles.add}
          onClick={onAddClick}
          title="Add session to this project"
          aria-label="Add session to group"
        >
          <IconPlus size={18} />
        </button>
      </div>
      {!group.collapsed && (
        <div className={styles.children}>
          {group.rows.map((row) =>
            row.kind === "pair" ? (
              <SplitPair key={`pair-${row.left.id}`} left={row.left} right={row.right} />
            ) : (
              <SessionRow key={row.session.id} session={row.session} />
            )
          )}
        </div>
      )}
    </div>
  );
}

// src/components/StatusBar.tsx
//
// DESIGN.md §3 + CONTEXT.md "Status Bar".
// LEFT segment: focus-aware summary.
//   - Terminal focused  -> "[shell] · [cwd]"
//   - MD Editor focused -> "[file] · Ln N, Col M"
//   - Quick Viewer      -> same as MD Editor (file name only — no cursor)
//   - Sidebar focused   -> workspace folder path
// RIGHT segment: "[workspace short name]  ⏵ N" — N counts running PTYs.
//
// v0.1 limitation: "running" means "PTY is alive", not "shell is in a
// foreground program". OSC 7 shell-integration (v0.2) refines this.

import { useMemo } from "react";

import styles from "@/components/StatusBar.module.css";
import { useMdStore } from "@/store/mdStore";
import { useLayoutStore } from "@/store/layoutStore";
import { usePtyStore } from "@/store/ptyStore";
import { useSessionsStore, isSessionVisible } from "@/store/sessionsStore";
import { useAgentStore } from "@/store/agentStore";
import { sessionAgentView, computeSessionSignal } from "@/sessions/sessionSignal";
import { useSidebarStore } from "@/store/sidebarStore";
import { basename } from "@/lib/sessions/groupingHelpers";
import { shellLabel } from "@/lib/shellsClient";

function shortName(path: string | null): string {
  if (!path) return "—";
  // Pick the trailing path segment; trim trailing slashes first.
  const trimmed = path.replace(/[/\\]+$/, "");
  const idx = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return idx === -1 ? trimmed : trimmed.slice(idx + 1);
}

export function StatusBar() {
  const focusedSurface = useMdStore((s) => s.focusedSurface);
  const focusedPaneId = useLayoutStore((s) => s.focusedPaneId);
  const panes = usePtyStore((s) => s.panes);
  const tabs = useMdStore((s) => s.tabs);
  const activeTabId = useMdStore((s) => s.activeTabId);
  const qvPath = useMdStore((s) => s.quickViewer.path);
  const workspaceFolder = useSidebarStore((s) => s.workspaceFolder);

  // Active session — drives the terminal-focused segment (§12). Selectors are
  // reactive so renaming the session/group or a branch-poll tick re-renders.
  const activeSessionId = useSessionsStore((s) => s.activeSessionId);
  const activeSession = useSessionsStore((s) =>
    activeSessionId ? s.sessions[activeSessionId] : null
  );
  const groupLabels = useSessionsStore((s) => s.groupLabels);

  // ---- LEFT segment ----
  let left = "";
  if (focusedSurface === "md-editor") {
    const tab = tabs.find((t) => t.id === activeTabId);
    if (tab) {
      const name = shortName(tab.path);
      // Ln/Col is not tracked in v0.1 (no CM-EditorView selector lift into
      // the store). Display the file name with a (-, -) placeholder so the
      // shape matches the spec; v0.2 wires selection state.
      left = `${name} · Ln —, Col —`;
    } else {
      left = "Editor";
    }
  } else if (focusedSurface === "quick-viewer") {
    left = qvPath ? shortName(qvPath) : "Quick Viewer";
  } else if (focusedSurface === "sidebar") {
    left = workspaceFolder ?? "";
  } else if (focusedSurface === "terminal" && focusedPaneId !== null) {
    // §12: "<group label> / <session name> · <shell> · ⎇ <branch>".
    // Per-pane cwd is NOT tracked in v1 — the old cwd column is dropped until
    // OSC 7 cwd polling lands (v1.2). Each segment is added only when present.
    const meta = panes[focusedPaneId];
    const parts: string[] = [];
    if (activeSession) {
      const groupLabel =
        groupLabels[activeSession.folderPath] ?? basename(activeSession.folderPath);
      parts.push(`${groupLabel} / ${activeSession.name}`);
    }
    if (meta) parts.push(shellLabel(meta.shell));
    if (activeSession?.gitBranch) parts.push(`⎇ ${activeSession.gitBranch}`);
    left = parts.length > 0 ? parts.join("  ·  ") : "Terminal";
  } else {
    // No focused surface yet (e.g. first launch before anything has focus).
    left = workspaceFolder ?? "";
  }

  // ---- RIGHT segment ----
  // Count panes whose status is "running". This is a v0.1 approximation —
  // see file-header note.
  const runningCount = Object.values(panes).filter(
    (p) => p.status === "running"
  ).length;
  const wsShort = shortName(workspaceFolder);

  // Needs-you roll-up (Plan 008): across BACKGROUND sessions (the visible one
  // never signals), count those blocked on permission vs waiting for your move.
  // Informational here; click-to-jump is future routing work.
  const sessions = useSessionsStore((s) => s.sessions);
  const splitView = useSessionsStore((s) => s.splitView);
  const agentPanes = useAgentStore((s) => s.panes);
  // Memoized: the StatusBar already re-renders on every ptyStore change (the
  // audited wide-subscription hot path), and this count only depends on the
  // session/agent slices — don't recount the fleet for unrelated renders.
  const [blockedCount, yourMoveCount] = useMemo(() => {
    let blocked = 0;
    let yourMove = 0;
    for (const sess of Object.values(sessions)) {
      const signal = computeSessionSignal({
        visible: isSessionVisible({ splitView, activeSessionId }, sess.id),
        unread: sess.unread,
        working: sess.working,
        agentSignal: sessionAgentView(agentPanes, sess).signal,
      });
      if (signal === "permission") blocked++;
      else if (signal === "your-move") yourMove++;
    }
    return [blocked, yourMove] as const;
  }, [sessions, splitView, activeSessionId, agentPanes]);

  return (
    <div className={styles.root} aria-label="Status Bar">
      <div className={styles.left} title={left}>
        {left}
      </div>
      <div className={styles.right}>
        {(blockedCount > 0 || yourMoveCount > 0) && (
          <span
            className={styles.needsYou}
            title={`${blockedCount} waiting on permission, ${yourMoveCount} your move`}
            aria-label={`${blockedCount} blocked on permission, ${yourMoveCount} awaiting your move`}
          >
            {blockedCount > 0 && <span className={styles.blocked}>{`◎ ${blockedCount}`}</span>}
            {yourMoveCount > 0 && <span className={styles.yourMove}>{`● ${yourMoveCount}`}</span>}
          </span>
        )}
        <span className={styles.workspace}>{wsShort}</span>
        {runningCount > 0 && (
          <>
            <span className={styles.sep}>·</span>
            <span
              className={styles.proc}
              title={`${runningCount} terminal${runningCount === 1 ? "" : "s"} running`}
              aria-label={`${runningCount} running terminals`}
            >
              {`⏵ ${runningCount}`}
            </span>
          </>
        )}
      </div>
    </div>
  );
}

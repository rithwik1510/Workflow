// src/components/TopBar.tsx
//
// Frameless custom titlebar (DESIGN.md §3, §5; CONTEXT.md "Frameless
// titlebar"). 36px tall. Drag region in the middle. Six action buttons on
// the left (sidebar · files · split · open-folder · shortcuts · MD editor),
// three on the right (preview · quick-viewer · settings), and three native
// window controls (min/max/close). All glyphs are custom stroke SVGs from
// components/icons.tsx (currentColor → theme-aware), not OS emoji.
//
// Critical invariant: EVERY clickable element inside the titlebar sets
// data-tauri-drag-region="false" on its root, otherwise the click is
// swallowed as a window drag. There's a regression test (TopBar.test.tsx)
// that walks the rendered DOM and asserts this.

import type { MouseEvent as ReactMouseEvent } from "react";

import styles from "@/components/TopBar.module.css";
import {
  IconSidebar,
  IconFolder,
  IconFolderOpen,
  IconSplit,
  IconKeyboard,
  IconEdit,
  IconEye,
  IconGlobe,
  IconDiff,
  IconSettings,
  IconMinimize,
  IconMaximize,
  IconClose,
} from "@/components/icons";
import { useMdStore } from "@/store/mdStore";
import { useDiffStore } from "@/store/diffStore";
import { usePreviewStore } from "@/store/previewStore";
import { useSessionsStore } from "@/store/sessionsStore";
import { useSidebarStore } from "@/store/sidebarStore";
import { useCoachStore } from "@/store/coachStore";
import { usePrefsStore } from "@/store/prefsStore";
import { useSettingsModalStore } from "@/store/settingsModalStore";
import { useShortcutsModalStore } from "@/store/shortcutsModalStore";
import { useSplitMenuStore } from "@/store/splitMenuStore";
import { pickAndOpenFolder } from "@/lib/sessions/sessionEntryFlows";
import {
  minimizeWindow,
  toggleMaximize,
  closeWindow,
} from "@/lib/windowControls";

export function TopBar() {
  const mdMode = useMdStore((s) => s.mdEditorMode);
  const setMdEditorMode = useMdStore((s) => s.setMdEditorMode);
  const qvOpen = useMdStore((s) => s.quickViewer.open);
  const qvPath = useMdStore((s) => s.quickViewer.path);
  const openMdInQuickViewer = useMdStore((s) => s.openMdInQuickViewer);
  const closeQuickViewer = useMdStore((s) => s.closeQuickViewer);

  // Diff tab — a full-area, git-powered review surface (Plan 010 Phase B).
  // Labeled (icon + text) like the Editor button so it reads as a destination,
  // not just a glyph. openDiff derives the session's repos + lists changes.
  const diffOpen = useDiffStore((s) => s.open);
  const onToggleDiff = () => {
    const d = useDiffStore.getState();
    if (d.open) d.closeDiff();
    else void d.openDiff();
  };

  const previewOpen = usePreviewStore((s) => s.open);
  const onTogglePreview = () => {
    const s = usePreviewStore.getState();
    if (s.open) s.closePreview();
    else s.openPreview();
  };

  const sidebarVisible = useSidebarStore((s) => s.sidebarVisible);
  const toggleSidebar = useSidebarStore((s) => s.toggleSidebar);
  const workspaceFolder = useSidebarStore((s) => s.workspaceFolder);

  // 🗂 File drawer toggle. Per-session: reads/writes the active session's
  // `fileTreeOpen` flag. No-op when no session is active. Per the Pre-Phase
  // spec correction, this is a NEW dedicated button (not the repurposed ☰,
  // which still toggles the sessions sidebar).
  const activeId = useSessionsStore((s) => s.activeSessionId);
  const fileDrawerOpen = useSessionsStore((s) =>
    activeId ? s.sessions[activeId]?.fileTreeOpen ?? false : false
  );
  const onToggleFileDrawer = () => {
    if (activeId) useSessionsStore.getState().toggleFileTree(activeId);
  };

  // ⊞ TopBar button: toggles the SplitMenu popover anchored at the
  // button's bottom-left. The popover dispatches splitPane on click;
  // the orchestrator spawns the PTY by reacting to the layout subscribe.
  //
  // The SplitMenu's window mousedown listener skips clicks on the
  // ⊞ button (via [data-split-menu-trigger]), so when the menu is open
  // and the user re-clicks ⊞, the listener does NOT close it first —
  // this handler sees store.open === true and closes the menu cleanly.
  const toggleSplitMenu = (e: ReactMouseEvent<HTMLButtonElement>) => {
    const store = useSplitMenuStore.getState();
    if (store.open) {
      store.close();
      return;
    }
    const rect = e.currentTarget.getBoundingClientRect();
    store.show(rect.left, rect.bottom + 4);
  };

  const onToggleQuickViewer = () => {
    if (qvOpen) {
      closeQuickViewer();
    } else if (qvPath !== null) {
      void openMdInQuickViewer(qvPath).catch((err) =>
        console.error("openMdInQuickViewer failed", err)
      );
    }
    // No-op when QV has no remembered path — matches keyboard shortcut.
  };

  const onSettings = () => {
    useSettingsModalStore.getState().openModal();
  };

  // ⌨ notification dot (Plan 014 §7): a shelved tip is waiting in "Shortcuts &
  // tips". Suppressed when Workflow tips are off — the coach is fully silent.
  const shelfHasNew = useCoachStore((s) => s.shelfHasNew);
  const tipsEnabled = usePrefsStore((s) => s.tipsEnabled);
  const showShelfDot = shelfHasNew && tipsEnabled;

  return (
    <div className={styles.root} data-tauri-drag-region>
      <div className={styles.left} data-tauri-drag-region="false">
        <button
          className={`${styles.btn} ${sidebarVisible ? styles.active : ""}`}
          title={sidebarVisible ? "Hide Sidebar (Ctrl+B)" : "Show Sidebar (Ctrl+B)"}
          aria-label="Toggle Sidebar"
          data-tauri-drag-region="false"
          onClick={toggleSidebar}
        >
          <IconSidebar />
        </button>
        <button
          className={`${styles.btn} ${fileDrawerOpen ? styles.active : ""}`}
          title="Toggle Files (Ctrl+Shift+E)"
          aria-label="Toggle file drawer"
          data-tauri-drag-region="false"
          onClick={onToggleFileDrawer}
        >
          <IconFolder />
        </button>
        <button
          className={styles.btn}
          title="Split focused pane (Ctrl+Alt+→/↑/↓)"
          aria-label="Split focused pane"
          data-tauri-drag-region="false"
          data-split-menu-trigger
          onClick={toggleSplitMenu}
        >
          <IconSplit />
        </button>
        <button
          className={styles.btn}
          title="Open Folder — switch or create session (Ctrl+K Ctrl+O)"
          aria-label="Open Folder"
          data-tauri-drag-region="false"
          onClick={() => void pickAndOpenFolder()}
        >
          <IconFolderOpen />
        </button>
        <button
          className={styles.btn}
          title="Shortcuts & tips (Ctrl+?)"
          aria-label="Shortcuts and tips"
          data-tauri-drag-region="false"
          onClick={() => useShortcutsModalStore.getState().openModal()}
        >
          <IconKeyboard />
          {showShelfDot && <span className={styles.shelfDot} aria-hidden="true" />}
        </button>
        {/* Editor entry point — labeled (icon + text) so it's an unmistakable
            destination rather than just another glyph. A divider sets it apart
            from the layout-control icons to its left. */}
        <span className={styles.divider} aria-hidden="true" />
        <button
          className={`${styles.btn} ${styles.labeled} ${mdMode === "full" ? styles.active : ""}`}
          title={mdMode === "full" ? "Close editor (Ctrl+E)" : "Open editor (Ctrl+E)"}
          aria-label="Toggle editor"
          data-tauri-drag-region="false"
          onClick={() => setMdEditorMode(mdMode === "full" ? "off" : "full")}
        >
          <IconEdit size={16} />
          <span className={styles.btnLabel}>Editor</span>
        </button>
      </div>

      <div
        className={styles.drag}
        data-tauri-drag-region
        // Double-click on the drag region toggles maximize (Windows convention).
        onDoubleClick={() => void toggleMaximize()}
        title={workspaceFolder ?? ""}
      />

      <div className={styles.right} data-tauri-drag-region="false">
        <button
          className={`${styles.btn} ${styles.labeled} ${diffOpen ? styles.active : ""}`}
          title={diffOpen ? "Close diff (Ctrl+Shift+D)" : "Review changes — git diff (Ctrl+Shift+D)"}
          aria-label="Toggle diff"
          data-tauri-drag-region="false"
          onClick={onToggleDiff}
        >
          <IconDiff size={16} />
          <span className={styles.btnLabel}>Diff</span>
        </button>
        <span className={styles.divider} aria-hidden="true" />
        <button
          className={`${styles.btn} ${previewOpen ? styles.active : ""}`}
          title={previewOpen ? "Close Preview (Ctrl+Shift+L)" : "Open Preview (Ctrl+Shift+L)"}
          aria-label="Toggle Preview"
          data-tauri-drag-region="false"
          onClick={onTogglePreview}
        >
          <IconGlobe />
        </button>
        <button
          className={`${styles.btn} ${qvOpen ? styles.active : ""}`}
          title={qvOpen ? "Close Quick Viewer (Ctrl+Shift+M)" : "Open Quick Viewer (Ctrl+Shift+M)"}
          aria-label="Toggle Quick Viewer"
          data-tauri-drag-region="false"
          onClick={onToggleQuickViewer}
        >
          <IconEye />
        </button>
        <button
          className={styles.btn}
          title="Settings (Ctrl+,)"
          aria-label="Settings"
          data-tauri-drag-region="false"
          onClick={onSettings}
        >
          <IconSettings />
        </button>
        <button
          className={styles.winBtn}
          title="Minimize"
          aria-label="Minimize"
          data-tauri-drag-region="false"
          onClick={() => void minimizeWindow()}
        >
          <IconMinimize />
        </button>
        <button
          className={styles.winBtn}
          title="Maximize"
          aria-label="Maximize"
          data-tauri-drag-region="false"
          onClick={() => void toggleMaximize()}
        >
          <IconMaximize />
        </button>
        <button
          className={`${styles.winBtn} ${styles.close}`}
          title="Close"
          aria-label="Close"
          data-tauri-drag-region="false"
          onClick={() => void closeWindow()}
        >
          <IconClose />
        </button>
      </div>
    </div>
  );
}

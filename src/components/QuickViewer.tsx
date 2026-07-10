// src/components/QuickViewer.tsx
//
// Read-only rendered markdown view (DESIGN.md §3 MD Quick Viewer,
// CONTEXT.md). Designed for "glancing at files an agent just wrote".
// Two header icons:
//   - pencil (✎): dispatches the file into the MD Editor Full View as a
//     tab. Editing only happens there — Quick Viewer has no editing
//     surface so we never have to reconcile two edits of the same file.
//   - close (✕): closes the Quick Viewer panel.

import { useEffect } from "react";

import styles from "@/components/QuickViewer.module.css";
import { IconClose } from "@/components/icons";
import { MdEditorPreview } from "@/components/MdEditorPreview";
import { useMdStore } from "@/store/mdStore";
import { useToastStore } from "@/store/toastStore";

/** Lucide-style pencil icon. currentColor stroke so it follows the
 *  button's color state. Same glyph as MdEditor for visual consistency. */
function PenIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" />
    </svg>
  );
}

export function QuickViewer() {
  const path = useMdStore((s) => s.quickViewer.path);
  const content = useMdStore((s) => s.quickViewer.content);
  const close = useMdStore((s) => s.closeQuickViewer);
  const openMdTab = useMdStore((s) => s.openMdTab);

  // Report focus surface for the Status Bar (DESIGN.md §3, CONTEXT.md
  // "Status Bar"). Mounting Quick Viewer implies the user is glancing at it.
  // On unmount — closed, OR hidden because the user switched to another session
  // (the viewer is project-scoped) — release focus so the Status Bar stops
  // describing this file. Only if it's still ours, so we don't stomp a surface
  // that took focus while we were open.
  useEffect(() => {
    useMdStore.getState().setFocusedSurface("quick-viewer");
    return () => {
      if (useMdStore.getState().focusedSurface === "quick-viewer") {
        useMdStore.getState().setFocusedSurface(null);
      }
    };
  }, []);

  if (path === null) return null;
  const fileName = path.split(/[/\\]/).pop() ?? path;

  // Dispatch into the MD Editor Full View. openMdTab handles the
  // "already-open" case (switches to that tab) and flips the editor
  // mode to "full" so the user lands directly on the file.
  const onEdit = () => {
    void openMdTab(path)
      .then(() => close())
      .catch((err) => {
        useToastStore.getState().push({
          severity: "error",
          message: `Open failed: ${err instanceof Error ? err.message : String(err)}`,
        });
      });
  };

  return (
    <div className={styles.root}>
      <div className={styles.header}>
        <span className={styles.title} title={path}>
          {fileName}
        </span>
        <div className={styles.actions}>
          <button
            className={styles.iconButton}
            title="Open in Editor"
            aria-label="Open in Editor"
            onClick={onEdit}
          >
            <PenIcon />
          </button>
          <button
            className={styles.iconButton}
            title="Close"
            aria-label="Close Quick Viewer"
            onClick={close}
          >
            <IconClose size={13} />
          </button>
        </div>
      </div>
      {/* Key on path so switching files (clicking a new link while the viewer
          is already open) remounts the body and replays the content fade. */}
      <div className={styles.body} key={path}>
        <MdEditorPreview source={content} filePath={path} />
      </div>
    </div>
  );
}

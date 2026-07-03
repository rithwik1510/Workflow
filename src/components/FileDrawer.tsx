// FileDrawer — secondary collapsible panel that shows the file tree for the
// active session's folderPath. Spec §8. Toggled by a topbar button (🗂).
//
// Mounts only when the active session has `fileTreeOpen === true`. When that
// flag flips OR the active session changes, the useEffect re-runs: the old
// file-watcher channel becomes orphaned (matches the pre-existing Sidebar
// behaviour — watchWorkspace is fire-and-forget; the Tauri channel emits
// until the renderer GCs the closure), and a fresh listDir + watch starts
// on the new folder.

import { useEffect, useRef } from "react";

import styles from "@/components/FileDrawer.module.css";
import { FileSearchResults } from "@/components/FileSearchResults";
import { SidebarTree } from "@/components/SidebarTree";
import { IconPlus, IconSearch } from "@/components/icons";
import { beginResize, endResize } from "@/components/resizeBus";
import { useMdStore } from "@/store/mdStore";
import { useSessionsStore } from "@/store/sessionsStore";
import { useSidebarStore } from "@/store/sidebarStore";
import { useToastStore } from "@/store/toastStore";
import { listDir, writeTextFile } from "@/lib/fsClient";
import { watchWorkspace } from "@/lib/fileWatcher";

// Slightly longer than --dur-panel (300ms) so the resize gate releases just
// after the width transition settles. Mirrors SessionsSidebar.
const SLIDE_SETTLE_MS = 360;

function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

export function FileDrawer() {
  const activeId = useSessionsStore((s) => s.activeSessionId);
  const session = useSessionsStore((s) => (activeId ? s.sessions[activeId] : null));
  const folder = session?.folderPath ?? null;
  const drawerOpen = session?.fileTreeOpen ?? false;

  const filterText = useSidebarStore((s) => s.filterText);
  const setFilter = useSidebarStore((s) => s.setFilter);
  const storeEntries = useSidebarStore((s) => s.storeEntries);
  const openMdTab = useMdStore((s) => s.openMdTab);

  // Suppress per-frame xterm fits while the drawer width-animates (the terminal
  // area resizes by 240px); fit once at settle. Same gate the sidebar uses.
  const firstRender = useRef(true);
  const resizing = useRef(false);
  const settleTimer = useRef<number | null>(null);
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    if (prefersReducedMotion()) return;
    if (!resizing.current) {
      resizing.current = true;
      beginResize();
    }
    if (settleTimer.current !== null) window.clearTimeout(settleTimer.current);
    settleTimer.current = window.setTimeout(() => {
      settleTimer.current = null;
      resizing.current = false;
      endResize();
    }, SLIDE_SETTLE_MS);
  }, [drawerOpen]);
  useEffect(
    () => () => {
      if (settleTimer.current !== null) window.clearTimeout(settleTimer.current);
      if (resizing.current) {
        resizing.current = false;
        endResize();
      }
    },
    []
  );

  useEffect(() => {
    if (!drawerOpen || folder === null) return;
    // Same noise-pattern + 300ms coalesce from the legacy Sidebar.tsx —
    // recursive home-dir watching otherwise floods the renderer with FS
    // events from AppData / .git / node_modules / etc.
    const NOISE_PATTERNS = [
      /[/\\]AppData[/\\]/i,
      /[/\\]\.git([/\\]|$)/i,
      /[/\\]node_modules([/\\]|$)/i,
      /[/\\]\.cache([/\\]|$)/i,
      /[/\\]\.turbo([/\\]|$)/i,
      /[/\\]\.next([/\\]|$)/i,
      /[/\\]target([/\\]|$)/i,
      /[/\\]dist([/\\]|$)/i,
      /[/\\]build([/\\]|$)/i,
      /[/\\]\.venv([/\\]|$)/i,
      /[/\\]__pycache__([/\\]|$)/i,
    ];
    const pendingDirs = new Set<string>();
    let flushTimer: number | null = null;
    const flush = () => {
      flushTimer = null;
      const dirs = Array.from(pendingDirs);
      pendingDirs.clear();
      for (const dir of dirs) {
        void listDir(dir)
          .then((es) => storeEntries(dir, es))
          .catch(() => undefined);
      }
    };
    const schedule = () => {
      if (flushTimer !== null) return;
      flushTimer = window.setTimeout(flush, 300);
    };

    // Initial listing — populate the tree's root entries immediately.
    void listDir(folder)
      .then((es) => storeEntries(folder, es))
      .catch(() => undefined);

    watchWorkspace(folder, (e) => {
      if (e.kind === "rescan") {
        void listDir(folder)
          .then((es) => storeEntries(folder, es))
          .catch(() => undefined);
        return;
      }
      if (NOISE_PATTERNS.some((p) => p.test(e.path))) return;
      const parent = e.path.replace(/[/\\][^/\\]+$/, "");
      if (parent.length === 0) return;
      pendingDirs.add(parent);
      schedule();
    });

    // Cleanup: clear the debounce timer if the drawer closes / folder changes
    // mid-flight. The Tauri watcher channel itself is fire-and-forget per
    // the existing Sidebar pattern — no unsubscribe API to call.
    return () => {
      if (flushTimer !== null) {
        window.clearTimeout(flushTimer);
        flushTimer = null;
      }
    };
  }, [drawerOpen, folder, storeEntries]);

  const onNewFile = async () => {
    if (folder === null) return;
    const name = window.prompt("New file name (relative to project root)");
    if (!name) return;
    // Use the name verbatim — the Editor handles any extension now (Plan 010).
    // A name with no extension is created as-is (e.g. "Dockerfile", "notes").
    const path = `${folder}/${name}`;
    try {
      await writeTextFile(path, "");
      // ＋ New File opens the new file in Editor Full View, not the Quick Viewer.
      await openMdTab(path);
    } catch (e) {
      useToastStore.getState().push({
        severity: "error",
        message: `Could not create file: ${e instanceof Error ? e.message : String(e)}`,
      });
    }
  };

  // No active session/folder → nothing to show (and nothing to slide).
  // Otherwise the shell stays mounted and animates its width via .collapsed so
  // it can slide in AND out; content stays mounted (clipped) during the slide.
  if (folder === null) return null;

  return (
    <div
      className={`${styles.drawer} ${drawerOpen ? "" : styles.collapsed}`}
      aria-hidden={!drawerOpen}
      {...(drawerOpen ? {} : { inert: "" })}
    >
      <div className={styles.inner}>
        <div className={styles.header}>
          <div className={styles.filterWrap}>
            <span className={styles.filterIcon} aria-hidden="true">
              <IconSearch size={13} />
            </span>
            <input
              className={styles.filter}
              type="text"
              placeholder="Filter"
              value={filterText}
              onChange={(e) => setFilter(e.target.value)}
              aria-label="Filter files"
            />
          </div>
          <button className={styles.iconButton} title="New file" onClick={onNewFile}>
            <IconPlus size={14} />
          </button>
        </div>
        <div className={styles.tree}>
          {filterText.trim() === "" ? (
            <SidebarTree path={folder} depth={0} />
          ) : (
            <FileSearchResults root={folder} query={filterText} />
          )}
        </div>
      </div>
    </div>
  );
}

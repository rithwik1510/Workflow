// Recursive renderer. Reads sidebarStore. Triggers lazy listDir when a folder
// is expanded for the first time.
import { useEffect, type MouseEvent as ReactMouseEvent } from "react";

import { SidebarRow } from "@/components/SidebarRow";
import { beginInternalFileDrag } from "@/lib/internalFileDrag";
import { useContextMenuStore } from "@/store/contextMenuStore";
import { useMdStore } from "@/store/mdStore";
import { useSidebarStore, COLLAPSED_DIRS } from "@/store/sidebarStore";
import { listDir } from "@/lib/fsClient";

interface Props {
  path: string;
  depth: number;
}

export function SidebarTree({ path, depth }: Props) {
  const entries = useSidebarStore((s) => s.entries.get(path));
  const expanded = useSidebarStore((s) => s.expanded);
  const matchesFilter = useSidebarStore((s) => s.matchesFilter);
  const toggleExpanded = useSidebarStore((s) => s.toggleExpanded);
  const storeEntries = useSidebarStore((s) => s.storeEntries);
  const openMdInQuickViewer = useMdStore((s) => s.openMdInQuickViewer);
  const openMdTab = useMdStore((s) => s.openMdTab);

  useEffect(() => {
    if (entries === undefined) {
      listDir(path)
        .then((es) => storeEntries(path, es))
        .catch(() => storeEntries(path, []));
    }
  }, [path, entries, storeEntries]);

  if (entries === undefined) return null;

  return (
    <>
      {entries
        .filter((e) => e.is_dir || matchesFilter(e.name))
        .map((entry) => {
          const isExpanded = expanded.has(entry.path);
          const dimmed = entry.is_dir && COLLAPSED_DIRS.has(entry.name) && !isExpanded;
          const isMd = entry.name.endsWith(".md");
          const onClick = () => {
            if (entry.is_dir) {
              toggleExpanded(entry.path);
            } else if (isMd) {
              // Markdown single-click → Quick Viewer glance.
              void openMdInQuickViewer(entry.path).catch((err) => {
                console.error("openMdInQuickViewer failed", err);
              });
            } else {
              // Code/text single-click → Editor tab (Plan 010).
              void openMdTab(entry.path).catch((err) => {
                console.error("openMdTab failed", err);
              });
            }
          };
          // Right-click on a file → context menu. Markdown offers Editor +
          // Quick Viewer; other files offer Editor (single-click already opens
          // it, but the menu keeps the affordance discoverable).
          const onContextMenu = entry.is_dir
            ? undefined
            : (e: ReactMouseEvent<HTMLDivElement>) => {
                e.preventDefault();
                e.stopPropagation();
                const items = [
                  {
                    label: "Open in Editor",
                    onClick: () => {
                      void openMdTab(entry.path).catch((err) => {
                        console.error("openMdTab failed", err);
                      });
                    },
                  },
                ];
                if (isMd) {
                  items.push({
                    label: "Open in Quick Viewer",
                    onClick: () => {
                      void openMdInQuickViewer(entry.path).catch((err) => {
                        console.error("openMdInQuickViewer failed", err);
                      });
                    },
                  });
                }
                useContextMenuStore.getState().openMenu(e.clientX, e.clientY, items);
              };
          // Files can be dragged onto a terminal pane to paste their path into
          // the agent (drag-drop file attach). We use a manual pointer-drag, NOT
          // HTML5 draggable: Tauri's dragDropEnabled (true, needed for the OS
          // drop) suppresses HTML5 dragover/drop on WebView2. Directories aren't
          // draggable — you attach files, not folders. The drag only starts past
          // a movement threshold, so a plain click still opens the Quick Viewer.
          const onMouseDown = entry.is_dir
            ? undefined
            : (e: ReactMouseEvent<HTMLDivElement>) => {
                if (e.button !== 0) return; // left button only
                beginInternalFileDrag(entry.path, e.clientX, e.clientY);
              };
          return (
            <div key={entry.path}>
              <SidebarRow
                name={entry.name}
                isDir={entry.is_dir}
                depth={depth}
                expanded={isExpanded}
                selected={false}
                dimmed={dimmed}
                onClick={onClick}
                onContextMenu={onContextMenu}
                onMouseDown={onMouseDown}
              />
              {entry.is_dir && isExpanded && (
                <SidebarTree path={entry.path} depth={depth + 1} />
              )}
            </div>
          );
        })}
    </>
  );
}

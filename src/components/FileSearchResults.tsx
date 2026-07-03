import { useEffect, useState, type MouseEvent as ReactMouseEvent } from "react";

import styles from "@/components/FileDrawer.module.css";
import { IconFile, IconFileText, IconFolder } from "@/components/icons";
import { searchFiles, type FileSearchResult } from "@/lib/fileSearch";
import { listDir } from "@/lib/fsClient";
import { beginInternalFileDrag } from "@/lib/internalFileDrag";
import { openPath } from "@/lib/openPath";
import { useContextMenuStore } from "@/store/contextMenuStore";
import { useMdStore } from "@/store/mdStore";
import { useSidebarStore } from "@/store/sidebarStore";

const SEARCH_DEBOUNCE_MS = 140;

interface Props {
  root: string;
  query: string;
}

type SearchState =
  | { status: "idle"; results: FileSearchResult[] }
  | { status: "loading"; results: FileSearchResult[] }
  | { status: "done"; results: FileSearchResult[] }
  | { status: "error"; results: FileSearchResult[] };

function isMarkdown(name: string): boolean {
  return /\.(md|mdx|markdown)$/i.test(name);
}

function trimSlash(path: string): string {
  return path.replace(/[/\\]+$/, "");
}

function parentPath(path: string): string {
  return path.replace(/[/\\][^/\\]+$/, "");
}

function pathKey(path: string): string {
  return trimSlash(path).replace(/\\/g, "/").toLowerCase();
}

function ancestorPaths(root: string, target: string): string[] {
  const cleanRoot = trimSlash(root);
  const rootLower = pathKey(cleanRoot);
  const ancestors: string[] = [];
  let current = trimSlash(target);

  while (current.length > 0 && pathKey(current) !== rootLower) {
    ancestors.unshift(current);
    const next = parentPath(current);
    if (next === current) break;
    current = next;
  }

  return ancestors;
}

function folderChainFor(root: string, result: FileSearchResult): string[] {
  const target = result.entry.is_dir ? result.entry.path : parentPath(result.entry.path);
  return ancestorPaths(root, target);
}

export function FileSearchResults({ root, query }: Props) {
  const [state, setState] = useState<SearchState>({ status: "idle", results: [] });
  const openMdInQuickViewer = useMdStore((s) => s.openMdInQuickViewer);
  const openMdTab = useMdStore((s) => s.openMdTab);
  const expandPaths = useSidebarStore((s) => s.expandPaths);
  const setFilter = useSidebarStore((s) => s.setFilter);
  const storeEntries = useSidebarStore((s) => s.storeEntries);

  useEffect(() => {
    const cleanQuery = query.trim();
    if (cleanQuery.length === 0) {
      setState({ status: "idle", results: [] });
      return;
    }

    let cancelled = false;
    setState((prev) => ({ status: "loading", results: prev.results }));
    const timer = window.setTimeout(() => {
      void searchFiles(root, cleanQuery, { maxDepth: 10, maxDirs: 1_500, maxResults: 140 })
        .then((results) => {
          if (!cancelled) setState({ status: "done", results });
        })
        .catch((err) => {
          console.error("file drawer search failed", err);
          if (!cancelled) setState({ status: "error", results: [] });
        });
    }, SEARCH_DEBOUNCE_MS);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [root, query]);

  const revealInTree = (result: FileSearchResult) => {
    const chain = folderChainFor(root, result);
    expandPaths(chain);
    for (const path of chain) {
      void listDir(path)
        .then((entries) => storeEntries(path, entries))
        .catch(() => undefined);
    }
    setFilter("");
  };

  const openResult = (result: FileSearchResult) => {
    if (result.entry.is_dir) {
      revealInTree(result);
      return;
    }
    if (isMarkdown(result.entry.name)) {
      void openMdInQuickViewer(result.entry.path).catch((err) => {
        console.error("openMdInQuickViewer failed", err);
      });
      return;
    }
    // Non-markdown files open in the Editor (Plan 010). Binary/oversized guards
    // run inside openMdTab; "Open with default app" stays on the context menu.
    void openMdTab(result.entry.path).catch((err) => {
      console.error("openMdTab failed", err);
    });
  };

  const openMenu = (e: ReactMouseEvent<HTMLButtonElement>, result: FileSearchResult) => {
    e.preventDefault();
    e.stopPropagation();

    if (result.entry.is_dir) {
      useContextMenuStore.getState().openMenu(e.clientX, e.clientY, [
        { label: "Show in Tree", onClick: () => revealInTree(result) },
        {
          label: "Open Folder",
          onClick: () => {
            void openPath(result.entry.path).catch((err) => {
              console.error("openPath failed", err);
            });
          },
        },
      ]);
      return;
    }

    if (isMarkdown(result.entry.name)) {
      useContextMenuStore.getState().openMenu(e.clientX, e.clientY, [
        {
          label: "Open in Editor",
          onClick: () => {
            void openMdTab(result.entry.path).catch((err) => {
              console.error("openMdTab failed", err);
            });
          },
        },
        {
          label: "Open in Quick Viewer",
          onClick: () => {
            void openMdInQuickViewer(result.entry.path).catch((err) => {
              console.error("openMdInQuickViewer failed", err);
            });
          },
        },
        { label: "Show in Tree", onClick: () => revealInTree(result) },
      ]);
      return;
    }

    useContextMenuStore.getState().openMenu(e.clientX, e.clientY, [
      {
        label: "Open in Editor",
        onClick: () => {
          void openMdTab(result.entry.path).catch((err) => {
            console.error("openMdTab failed", err);
          });
        },
      },
      {
        label: "Open with default app",
        onClick: () => {
          void openPath(result.entry.path).catch((err) => {
            console.error("openPath failed", err);
          });
        },
      },
      { label: "Show in Tree", onClick: () => revealInTree(result) },
    ]);
  };

  if (state.status === "loading" && state.results.length === 0) {
    return <div className={styles.searchState}>Searching...</div>;
  }

  if (state.status === "error") {
    return <div className={styles.searchState}>Search failed</div>;
  }

  if (state.status === "done" && state.results.length === 0) {
    return <div className={styles.searchState}>No matches</div>;
  }

  return (
    <div className={styles.searchResults}>
      {state.results.map((result) => {
        const Icon = result.entry.is_dir
          ? IconFolder
          : isMarkdown(result.entry.name)
          ? IconFileText
          : IconFile;
        const location = result.parentRelativePath || ".";
        return (
          <button
            key={result.entry.path}
            type="button"
            className={styles.searchRow}
            onClick={() => openResult(result)}
            onContextMenu={(e) => openMenu(e, result)}
            onMouseDown={
              result.entry.is_dir
                ? undefined
                : (e) => {
                    if (e.button !== 0) return;
                    beginInternalFileDrag(result.entry.path, e.clientX, e.clientY);
                  }
            }
            title={result.relativePath}
          >
            <span className={styles.searchResultIcon} aria-hidden="true">
              <Icon size={13} />
            </span>
            <span className={styles.searchResultText}>
              <span className={styles.searchResultName}>{result.entry.name}</span>
              <span className={styles.searchResultPath}>{location}</span>
            </span>
          </button>
        );
      })}
      {state.status === "loading" && <div className={styles.searchState}>Updating...</div>}
    </div>
  );
}

// src/components/DiffView.tsx
//
// The Diff tab surface (Plan 010 Phase B). Replaces the central area — exactly
// like the Editor Full View (MdEditor) — with a Conductor-style two-pane review
// of the working tree: a changed-file list on the left, an old⇄new diff on the
// right, powered entirely by git (read-only). Arbitration with the other
// central-area surfaces (Editor, split view) lives in App.tsx.
//
// Chrome mirrors MdEditor: a 36px header band (border-bottom), the same
// view-fade-in entrance, presence-eased sub-panels, and var() fallbacks on every
// custom property so one undefined token can't invalidate a whole declaration
// (the documented SessionRow.module.css gotcha).
//
// Data flow: diffStore holds the repo set + file list + selection; each file's
// diff content is fetched on demand here (gitFileDiff) and rendered with
// @codemirror/merge via mergeSetup, using Phase A's lazy language loading so the
// diff is syntax-highlighted with the same grammars as the editor.

import { useEffect, useRef, useState } from "react";

import styles from "@/components/DiffView.module.css";
import { IconClose, IconDiff, IconRefresh, IconFile, IconGitBranch } from "@/components/icons";
import { LandMenu } from "@/components/LandMenu";
import { buildDiffView, type DiffHandle } from "@/codemirror/mergeSetup";
import { resolveLanguageExtension } from "@/codemirror/languages";
import { gitFileDiff, type ChangedFile, type ChangedFileStatus } from "@/lib/gitClient";
import { useDiffStore, type DiffViewMode } from "@/store/diffStore";
import { useAttemptStore } from "@/store/attemptStore";
import { useSessionsStore } from "@/store/sessionsStore";
import { useMdStore } from "@/store/mdStore";
import { tabKindForPath } from "@/store/mdStore";

// ---------- status glyphs ----------

/** Single-letter badge for a change kind. Styled (colour + weight), not raw
 *  letters, so the list scans at a glance: M amber, A green, D red, R blue,
 *  untracked green (a whole-file addition). */
const STATUS_META: Record<ChangedFileStatus, { glyph: string; cls: string; label: string }> = {
  modified: { glyph: "M", cls: styles.glyphM!, label: "Modified" },
  added: { glyph: "A", cls: styles.glyphA!, label: "Added" },
  deleted: { glyph: "D", cls: styles.glyphD!, label: "Deleted" },
  renamed: { glyph: "R", cls: styles.glyphR!, label: "Renamed" },
  untracked: { glyph: "U", cls: styles.glyphU!, label: "Untracked" },
};

function StatusGlyph({ status }: { status: ChangedFileStatus }) {
  const meta = STATUS_META[status];
  return (
    <span className={`${styles.glyph} ${meta.cls}`} title={meta.label} aria-hidden="true">
      {meta.glyph}
    </span>
  );
}

/** Split a repo-relative path into { name, dir } for a two-tone row (name bright,
 *  parent dir dim). Handles both slash styles defensively. */
function splitPath(path: string): { name: string; dir: string } {
  const parts = path.split(/[/\\]/);
  const name = parts.pop() ?? path;
  return { name, dir: parts.join("/") };
}

/** Join a git repo root (forward slashes) with a repo-relative path for opening
 *  in the editor. Preserve the repo's separator style so the resulting absolute
 *  path matches what the rest of the app uses. */
function joinRepoPath(repo: string, rel: string): string {
  const sep = repo.includes("\\") && !repo.includes("/") ? "\\" : "/";
  const relNative = sep === "\\" ? rel.replace(/\//g, "\\") : rel;
  const base = repo.replace(/[/\\]$/, "");
  return `${base}${sep}${relNative}`;
}

// ---------- file list ----------

function FileRow({
  repo,
  file,
  active,
  onSelect,
}: {
  repo: string;
  file: ChangedFile;
  active: boolean;
  onSelect: () => void;
}) {
  const { name, dir } = splitPath(file.path);
  const openInEditor = (e: React.MouseEvent) => {
    e.stopPropagation();
    // Deleted files have no working-tree content to open — skip.
    if (file.status === "deleted") return;
    const abs = joinRepoPath(repo, file.path);
    void useMdStore.getState().openMdTab(abs);
  };
  return (
    <div
      className={`${styles.fileRow} ${active ? styles.fileActive : ""}`}
      role="option"
      aria-selected={active}
      tabIndex={0}
      title={file.path}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect();
        }
      }}
    >
      <StatusGlyph status={file.status} />
      <span className={styles.fileName}>{name}</span>
      {dir && <span className={styles.fileDir}>{dir}</span>}
      {file.status !== "deleted" && (
        <button
          type="button"
          className={styles.openBtn}
          title="Open in editor"
          aria-label={`Open ${name} in editor`}
          onClick={openInEditor}
        >
          <IconFile size={13} />
        </button>
      )}
    </div>
  );
}

// ---------- diff content (per selected file) ----------

type ContentState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "binary" }
  | { kind: "large" }
  | { kind: "ready"; oldText: string; newText: string; language: import("@codemirror/state").Extension };

function DiffContent({
  repo,
  file,
  viewMode,
  base,
}: {
  repo: string;
  file: ChangedFile;
  viewMode: DiffViewMode;
  /** Old-side ref: null = HEAD, or a merge-base SHA for an attempt session. */
  base: string | null;
}) {
  const [state, setState] = useState<ContentState>({ kind: "loading" });
  const hostRef = useRef<HTMLDivElement | null>(null);

  // Fetch old/new text + resolve the grammar. Keyed on the file identity (NOT
  // viewMode) so flipping unified⇄split rebuilds from cached text without a
  // re-fetch. A newer selection supersedes an in-flight fetch via `disposed`.
  useEffect(() => {
    let disposed = false;
    setState({ kind: "loading" });
    void (async () => {
      try {
        const [diff, language] = await Promise.all([
          gitFileDiff(repo, file.path, file.oldPath, base),
          resolveLanguageExtension(file.path, tabKindForPath(file.path)),
        ]);
        if (disposed) return;
        if (diff.binary) setState({ kind: "binary" });
        else if (diff.tooLarge) setState({ kind: "large" });
        else
          setState({
            kind: "ready",
            oldText: diff.oldText,
            newText: diff.newText,
            language,
          });
      } catch (err) {
        if (disposed) return;
        setState({ kind: "error", message: err instanceof Error ? err.message : String(err) });
      }
    })();
    return () => {
      disposed = true;
    };
  }, [repo, file.path, file.oldPath, base]);

  // Build (and rebuild on viewMode change) the CodeMirror diff once text is
  // ready. The host div only mounts in the "ready" branch, so it's present here.
  useEffect(() => {
    if (state.kind !== "ready" || !hostRef.current) return;
    let handle: DiffHandle | null = null;
    handle = buildDiffView({
      parent: hostRef.current,
      oldText: state.oldText,
      newText: state.newText,
      unified: viewMode === "unified",
      language: state.language,
    });
    return () => handle?.destroy();
  }, [state, viewMode]);

  if (state.kind === "loading") {
    return <div className={styles.contentMsg}>Loading diff…</div>;
  }
  if (state.kind === "error") {
    return <div className={styles.contentMsg}>Couldn’t load diff: {state.message}</div>;
  }
  if (state.kind === "binary") {
    return (
      <div className={styles.contentMsg}>
        <p className={styles.msgTitle}>Binary file</p>
        <p className={styles.msgHint}>No text diff to show.</p>
      </div>
    );
  }
  if (state.kind === "large") {
    return (
      <div className={styles.contentMsg}>
        <p className={styles.msgTitle}>File too large to diff</p>
        <p className={styles.msgHint}>Open it in the editor to view.</p>
      </div>
    );
  }
  return <div className={styles.cm} ref={hostRef} />;
}

// ---------- surface ----------

export function DiffView() {
  const repos = useDiffStore((s) => s.repos);
  const activeRepo = useDiffStore((s) => s.activeRepo);
  const files = useDiffStore((s) => s.files);
  const selectedPath = useDiffStore((s) => s.selectedPath);
  const viewMode = useDiffStore((s) => s.viewMode);
  const loading = useDiffStore((s) => s.loading);
  const error = useDiffStore((s) => s.error);
  const baseBranch = useDiffStore((s) => s.baseBranch);
  const attemptRepo = useDiffStore((s) => s.attemptRepo);
  const mergeBase = useDiffStore((s) => s.mergeBase);
  const baseMode = useDiffStore((s) => s.baseMode);
  const activeBase = useDiffStore((s) => s.activeBase);

  const setActiveRepo = useDiffStore((s) => s.setActiveRepo);
  const selectFile = useDiffStore((s) => s.selectFile);
  const setViewMode = useDiffStore((s) => s.setViewMode);
  const setBaseMode = useDiffStore((s) => s.setBaseMode);
  const refresh = useDiffStore((s) => s.refresh);
  const closeDiff = useDiffStore((s) => s.closeDiff);

  // Land applies to the ACTIVE session's attempt (the Diff tab is session-
  // scoped). Look it up here so the button only shows for attempt sessions.
  const activeSessionId = useSessionsStore((s) => s.activeSessionId);
  const attempt = useAttemptStore((s) =>
    activeSessionId ? s.attempts[activeSessionId] : undefined
  );
  const [landOpen, setLandOpen] = useState(false);

  const selectedFile = files.find((f) => f.path === selectedPath) ?? null;
  const repoName = activeRepo ? splitPath(activeRepo).name : null;

  // The base toggle only makes sense when a merge-base resolved AND we're looking
  // at the attempt's own repo (a multi-repo session's other repos are HEAD-only).
  const showBaseToggle =
    !!baseBranch && !!mergeBase && !!activeRepo && activeRepo === attemptRepo;

  return (
    <div className={styles.root}>
      <div className={styles.header}>
        <div className={styles.headerLeft}>
          <IconDiff size={16} />
          <span className={styles.title}>Diff</span>
          {repos.length > 1 ? (
            <select
              className={styles.repoSelect}
              value={activeRepo ?? ""}
              onChange={(e) => void setActiveRepo(e.target.value)}
              aria-label="Repository"
            >
              {repos.map((r) => (
                <option key={r} value={r}>
                  {splitPath(r).name}
                </option>
              ))}
            </select>
          ) : (
            repoName && <span className={styles.repoName}>{repoName}</span>
          )}
        </div>
        <div className={styles.headerRight}>
          {showBaseToggle && (
            <div className={styles.segmented} role="group" aria-label="Diff base">
              <button
                type="button"
                className={`${styles.segBtn} ${baseMode === "mergeBase" ? styles.segActive : ""}`}
                aria-pressed={baseMode === "mergeBase"}
                title={`Diff everything this attempt changed since it forked from ${baseBranch}`}
                onClick={() => void setBaseMode("mergeBase")}
              >
                vs {baseBranch}
              </button>
              <button
                type="button"
                className={`${styles.segBtn} ${baseMode === "head" ? styles.segActive : ""}`}
                aria-pressed={baseMode === "head"}
                title="Diff only the uncommitted working-tree changes"
                onClick={() => void setBaseMode("head")}
              >
                vs HEAD
              </button>
            </div>
          )}
          {attempt && activeSessionId && (
            <div className={styles.landWrap}>
              <button
                type="button"
                className={`${styles.textBtn} ${landOpen ? styles.textBtnActive : ""}`}
                aria-haspopup="menu"
                aria-expanded={landOpen}
                title="Land this attempt (PR, merge, or clean up)"
                onClick={() => setLandOpen((v) => !v)}
              >
                <IconGitBranch size={14} />
                <span>Land…</span>
              </button>
              <LandMenu
                open={landOpen}
                attempt={attempt}
                sessionId={activeSessionId}
                onClose={() => setLandOpen(false)}
              />
            </div>
          )}
          <div className={styles.segmented} role="group" aria-label="Diff layout">
            <button
              type="button"
              className={`${styles.segBtn} ${viewMode === "unified" ? styles.segActive : ""}`}
              aria-pressed={viewMode === "unified"}
              onClick={() => setViewMode("unified")}
            >
              Unified
            </button>
            <button
              type="button"
              className={`${styles.segBtn} ${viewMode === "split" ? styles.segActive : ""}`}
              aria-pressed={viewMode === "split"}
              onClick={() => setViewMode("split")}
            >
              Split
            </button>
          </div>
          <button
            type="button"
            className={styles.iconBtn}
            title="Refresh"
            aria-label="Refresh diff"
            onClick={() => void refresh()}
          >
            <IconRefresh size={15} />
          </button>
          <button
            type="button"
            className={styles.iconBtn}
            title="Close diff (Ctrl+Shift+D)"
            aria-label="Close diff"
            onClick={closeDiff}
          >
            <IconClose size={13} />
          </button>
        </div>
      </div>

      {repos.length === 0 ? (
        <div className={styles.emptyFull}>
          <p className={styles.emptyTitle}>No git repository found</p>
          <p className={styles.emptyHint}>
            This session’s folders aren’t inside a git repo, so there’s nothing to diff.
          </p>
        </div>
      ) : (
        <div className={styles.body}>
          <div className={styles.list} role="listbox" aria-label="Changed files">
            {loading && files.length === 0 ? (
              <div className={styles.listMsg}>Scanning working tree…</div>
            ) : error ? (
              <div className={styles.listMsg}>{error}</div>
            ) : files.length === 0 ? (
              <div className={styles.listMsg}>
                <p className={styles.emptyTitle}>No changes</p>
                <p className={styles.emptyHint}>The working tree is clean.</p>
              </div>
            ) : (
              files.map((f) => (
                <FileRow
                  key={f.path}
                  repo={activeRepo!}
                  file={f}
                  active={f.path === selectedPath}
                  onSelect={() => selectFile(f.path)}
                />
              ))
            )}
          </div>
          <div className={styles.detail}>
            {selectedFile && activeRepo ? (
              <DiffContent
                key={`${activeRepo}:${activeBase ?? "HEAD"}:${selectedFile.path}`}
                repo={activeRepo}
                file={selectedFile}
                viewMode={viewMode}
                base={activeBase}
              />
            ) : (
              <div className={styles.contentMsg}>
                {files.length > 0 ? "Select a file to view its diff." : ""}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/** Slim, presence-eased wrapper is unnecessary — the surface swaps like MdEditor
 *  (view-fade-in on enter). Default export matches the lazy import in App.tsx. */
export default DiffView;

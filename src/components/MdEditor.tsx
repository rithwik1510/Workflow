// src/components/MdEditor.tsx
//
// The Editor Full View (Plan 010 Phase A — generalized from MD-only). Every
// open tab is EITHER a Markdown file (rendered-HTML view ⇄ CodeMirror source,
// toggled by the pen) OR a code/text file (plain CodeMirror, no preview). A
// slim banner above the body handles the two agent-safety states:
//   - readOnly (file > 1.5 MB)      → "Read-only" notice
//   - conflict (changed on disk)    → "Changed on disk — [Reload] [Keep mine]"
//
// Language highlighting loads LAZILY (languages.ts) and is injected into the
// live view via a Compartment after the text is already on screen, so opening a
// file never blocks on parsing @codemirror/language-data.

import { useEffect, useRef, useState } from "react";

import styles from "@/components/MdEditor.module.css";
import { buildEditor } from "@/codemirror/setup";
import { languageCompartment, resolveLanguageExtension } from "@/codemirror/languages";
import { MdEditorPreview } from "@/components/MdEditorPreview";
import { MdEditorTabStrip } from "@/components/MdEditorTabStrip";
import { IconFolderOpen, IconSave } from "@/components/icons";
import { usePresence } from "@/hooks/usePresence";
import { pickEditorFile } from "@/lib/dialogClient";
import { useMdStore } from "@/store/mdStore";
import { useToastStore } from "@/store/toastStore";
import { EditorSelection } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";

type Mode = "view" | "edit";

interface EditorMemory {
  anchor: number;
  head: number;
  scrollTop: number;
  scrollLeft: number;
}

/** Pencil glyph. Lucide-style 2-path edit icon (page + tip). currentColor
 *  inherits from the button, so the SVG follows our view/edit accent states. */
function PenIcon() {
  return (
    <svg
      width="18"
      height="18"
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

/** Conflict bar — slim, top-anchored strip shown only when a dirty tab's file
 *  changed on disk. usePresence keeps it mounted through its exit transition so
 *  it eases out after the user resolves it. */
function ConflictBar({ tabId }: { tabId: string }) {
  const conflict = useMdStore(
    (s) => s.tabs.find((t) => t.id === tabId)?.conflict ?? null
  );
  const reloadTab = useMdStore((s) => s.reloadTab);
  const keepConflictMine = useMdStore((s) => s.keepConflictMine);
  const { mounted, state } = usePresence(conflict !== null);
  if (!mounted) return null;
  return (
    <div className={styles.conflictBar} data-state={state} role="alert">
      <span className={styles.conflictText}>Changed on disk</span>
      <div className={styles.conflictActions}>
        <button
          type="button"
          className={styles.conflictBtn}
          onClick={() => reloadTab(tabId)}
        >
          Reload
        </button>
        <button
          type="button"
          className={styles.conflictBtnGhost}
          onClick={() => keepConflictMine(tabId)}
        >
          Keep mine
        </button>
      </div>
    </div>
  );
}

export function MdEditor() {
  const activeTabId = useMdStore((s) => s.activeTabId);
  const tab = useMdStore((s) => s.tabs.find((t) => t.id === activeTabId) ?? null);
  const setTabContent = useMdStore((s) => s.setTabContent);
  const openMdTab = useMdStore((s) => s.openMdTab);
  const saveMdTab = useMdStore((s) => s.saveMdTab);

  // Open a file through the native OS picker — the intuitive alternative to
  // typing an absolute path into Ctrl+O. Any file: guards run on open.
  const openFileViaPicker = async () => {
    try {
      const path = await pickEditorFile();
      if (path) await openMdTab(path);
    } catch (err) {
      useToastStore.getState().push({
        severity: "error",
        message: `Couldn't open file: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  };

  const [mode, setMode] = useState<Mode>("view");
  useEffect(() => {
    // Report focus surface for the Status Bar (DESIGN.md §3). Mounting MdEditor
    // implies the user is reading it.
    useMdStore.getState().setFocusedSurface("md-editor");
  }, [tab?.id]);

  const isCode = tab?.kind === "code";
  // Code files have no rendered preview — always the source editor. Markdown
  // obeys the pen toggle (default: rendered view).
  const showEditor = tab !== null && (isCode || mode === "edit");

  const editorHostRef = useRef<HTMLDivElement | null>(null);
  const editorViewRef = useRef<EditorView | null>(null);
  const editorMemoryRef = useRef(new Map<string, EditorMemory>());

  // Build the CodeMirror EditorView when the source editor is shown; destroy
  // when it's hidden. Doc is seeded from the store's current tab.content; edits
  // flow back via setTabContent. The file's grammar loads lazily and is
  // injected once resolved.
  useEffect(() => {
    if (!showEditor || !editorHostRef.current || tab === null) return;
    const memory = editorMemoryRef.current.get(tab.id);
    const docLen = tab.content.length;
    const view = buildEditor({
      parent: editorHostRef.current,
      doc: tab.content,
      readOnly: tab.readOnly,
      lineNumbersOn: true,
      selection: memory
        ? EditorSelection.single(
            Math.min(memory.anchor, docLen),
            Math.min(memory.head, docLen)
          )
        : undefined,
      onChange: (doc) => setTabContent(tab.id, doc),
    });
    editorViewRef.current = view;

    // Lazy language: resolve the grammar off the critical path, then reconfigure
    // the compartment in place. Guard against the view being torn down first.
    let disposed = false;
    void resolveLanguageExtension(tab.path, tab.kind).then((ext) => {
      if (disposed) return;
      view.dispatch({ effects: languageCompartment.reconfigure(ext) });
    });

    const raf = window.requestAnimationFrame(() => {
      if (!memory) return;
      view.scrollDOM.scrollTop = memory.scrollTop;
      view.scrollDOM.scrollLeft = memory.scrollLeft;
    });
    return () => {
      disposed = true;
      window.cancelAnimationFrame(raf);
      const main = view.state.selection.main;
      editorMemoryRef.current.set(tab.id, {
        anchor: main.anchor,
        head: main.head,
        scrollTop: view.scrollDOM.scrollTop,
        scrollLeft: view.scrollDOM.scrollLeft,
      });
      view.destroy();
      editorViewRef.current = null;
    };
    // Tab identity + which-surface are the only triggers; depending on
    // `tab.content` would rebuild the editor on every keystroke.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab?.id, showEditor]);

  // Reconcile the live view with external content changes (a clean tab reloaded
  // from disk by the watcher, or a conflict resolved via Reload). Typing also
  // changes tab.content, but then view.doc already equals it, so the guard makes
  // this a no-op in the common case — no keystroke feedback loop.
  useEffect(() => {
    const view = editorViewRef.current;
    if (!view || tab === null) return;
    const cur = view.state.doc.toString();
    if (cur !== tab.content) {
      view.dispatch({ changes: { from: 0, to: cur.length, insert: tab.content } });
    }
  }, [tab?.content, tab]);

  const togglePen = () => setMode((m) => (m === "view" ? "edit" : "view"));
  const penLabel = mode === "edit" ? "Switch to view mode" : "Switch to edit mode";

  return (
    <div className={styles.root}>
      <div className={styles.header}>
        <MdEditorTabStrip />
        <button
          className={styles.penButton}
          onClick={() => void openFileViaPicker()}
          title="Open file… (Ctrl+O)"
          aria-label="Open file"
        >
          <IconFolderOpen size={18} />
        </button>
        {tab !== null && (
          <button
            className={styles.penButton}
            onClick={() => void saveMdTab(tab.id)}
            title={tab.readOnly ? "Read-only file" : "Save"}
            aria-label="Save"
            disabled={!tab.dirty || tab.readOnly}
          >
            <IconSave size={16} />
          </button>
        )}
        {/* Preview toggle is Markdown-only — code files have no rendered view. */}
        {tab !== null && !isCode && (
          <button
            className={`${styles.penButton} ${mode === "edit" ? styles.penActive : ""}`}
            onClick={togglePen}
            title={penLabel}
            aria-label={penLabel}
            aria-pressed={mode === "edit"}
          >
            <PenIcon />
          </button>
        )}
      </div>
      {tab !== null && tab.readOnly && (
        <div className={styles.readOnlyBanner} role="status">
          Read-only — file exceeds 1.5&nbsp;MB. Editing is disabled.
        </div>
      )}
      {tab !== null && <ConflictBar tabId={tab.id} />}
      <div className={styles.body}>
        {tab === null ? (
          <div className={styles.empty}>
            <p className={styles.emptyTitle}>No file open</p>
            <button className={styles.openBtn} onClick={() => void openFileViaPicker()}>
              <IconFolderOpen size={16} />
              <span>Open a file…</span>
            </button>
            <p className={styles.emptyHint}>or press Ctrl+O</p>
          </div>
        ) : showEditor ? (
          <div className={styles.editor}>
            <div className={styles.cm} ref={editorHostRef} />
          </div>
        ) : (
          <div className={styles.view}>
            <MdEditorPreview source={tab.content} filePath={tab.path} />
          </div>
        )}
      </div>
    </div>
  );
}

export default MdEditor;

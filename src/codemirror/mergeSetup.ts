// src/codemirror/mergeSetup.ts — build a read-only diff view for the Diff tab
// (Plan 010 Phase B) on top of @codemirror/merge (the ONE new dependency).
//
// Two renderings from the SAME old/new text pair:
//   - unified: a single EditorView showing deletions inline (struck) above
//     additions, via unifiedMergeView. mergeControls:false because this is pure
//     observation — no accept/reject hunk buttons (that would be editing).
//   - split: a MergeView (two side-by-side EditorViews) with change highlights
//     and a connecting gutter.
//
// Both reuse the app's editor chrome — lumeTheme (fonts/colours from our CSS
// tokens), syntax highlighting, line numbers, code folding — and are strictly
// read-only. The caller resolves the language extension lazily (languages.ts)
// and passes it in, so diffs are highlighted with the same grammars as the
// editor without pulling language-data onto the first-paint path.

import { unifiedMergeView, MergeView } from "@codemirror/merge";
import {
  defaultHighlightStyle,
  foldGutter,
  syntaxHighlighting,
} from "@codemirror/language";
import { EditorState, type Extension } from "@codemirror/state";
import { EditorView, lineNumbers } from "@codemirror/view";

import { lumeTheme } from "@/codemirror/theme";

export interface BuildDiffOptions {
  parent: HTMLElement;
  oldText: string;
  newText: string;
  unified: boolean;
  /** Lazily-resolved language extension (or [] for plain). */
  language: Extension;
}

/** A built diff view. `destroy` tears down whichever underlying view was made,
 *  so DiffView can dispose without knowing which mode is live. */
export interface DiffHandle {
  destroy: () => void;
}

/** Chrome shared by every diff editor: read-only, line numbers, folding, our
 *  theme + highlight style, and the resolved grammar. Read-only is enforced at
 *  BOTH layers (EditorState.readOnly blocks transactions; EditorView.editable
 *  hides the caret / drops key handling) so nothing about a diff feels typeable. */
function baseExtensions(language: Extension): Extension[] {
  return [
    lineNumbers(),
    foldGutter(),
    syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
    lumeTheme,
    EditorState.readOnly.of(true),
    EditorView.editable.of(false),
    EditorView.lineWrapping,
    language,
  ];
}

export function buildDiffView(opts: BuildDiffOptions): DiffHandle {
  if (opts.unified) {
    const view = new EditorView({
      parent: opts.parent,
      state: EditorState.create({
        doc: opts.newText,
        extensions: [
          ...baseExtensions(opts.language),
          // `original` is the OLD side; the doc is the NEW side. Deletions from
          // old render inline. mergeControls off → observation only.
          unifiedMergeView({
            original: opts.oldText,
            mergeControls: false,
            gutter: true,
            syntaxHighlightDeletions: true,
          }),
        ],
      }),
    });
    return { destroy: () => view.destroy() };
  }

  const mv = new MergeView({
    parent: opts.parent,
    a: { doc: opts.oldText, extensions: baseExtensions(opts.language) },
    b: { doc: opts.newText, extensions: baseExtensions(opts.language) },
    gutter: true,
    highlightChanges: true,
    // Fold long stretches of identical context so the eye lands on the changes.
    collapseUnchanged: { margin: 3, minSize: 4 },
  });
  return { destroy: () => mv.destroy() };
}

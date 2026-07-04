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

// GitHub/Codex-style diff coloring.
//
// @codemirror/merge's built-in change backgrounds are ~8% opacity (`rgba(160,
// 128, 100, .08)` for removed, `rgba(100, 160, 128, .08)` for added) — tuned for
// a LIGHT editor. On our near-black diff surface (--bg-0 #0a0a0a) an 8% tint is
// effectively invisible, so "what changed" never reads. We override with
// stronger, token-hued bands (red = old/deleted side, green = new/added side),
// a solid gutter bar so the changed ROW catches the eye, and a brighter inline
// highlight on the exact tokens that changed. This theme is added AFTER the
// library's baseTheme, so on equal specificity these rules win.
//
// Colors trace our design tokens: --success #7fc26b (green), --error #e85a5a
// (red). Kept as literals (not var()) because CodeMirror injects theme rules
// into a managed stylesheet where a failed var() would silently drop the whole
// band — the exact invisibility we're fixing.
const DEL_LINE = "rgba(232, 90, 90, 0.14)"; // removed line band
const DEL_TOKEN = "rgba(232, 90, 90, 0.32)"; // removed inline token
const DEL_BAR = "#c74a4a"; // removed gutter bar
const ADD_LINE = "rgba(127, 194, 107, 0.14)"; // added line band
const ADD_TOKEN = "rgba(127, 194, 107, 0.30)"; // added inline token
const ADD_BAR = "#5aa347"; // added gutter bar

const diffTheme = EditorView.theme(
  {
    // Whole-line bands. In split view each side editor root carries cm-merge-a
    // (old) / cm-merge-b (new); in unified view the doc editor is cm-merge-b and
    // removals render as .cm-deletedChunk / .cm-deletedLine widgets.
    "&.cm-merge-a .cm-changedLine, .cm-deletedChunk, .cm-deletedLine": {
      backgroundColor: DEL_LINE,
    },
    "&.cm-merge-b .cm-changedLine, .cm-inlineChangedLine, .cm-insertedLine": {
      backgroundColor: ADD_LINE,
    },
    // Inline changed tokens — a solid fill (the default is a 2px underline that's
    // hard to see) so the exact edit within a line stands out.
    "&.cm-merge-a .cm-changedText, .cm-deletedChunk .cm-deletedText, .cm-deletedText":
      {
        background: DEL_TOKEN,
        borderRadius: "2px",
      },
    "&.cm-merge-b .cm-changedText, .cm-insertedLine .cm-changedText": {
      background: ADD_TOKEN,
      borderRadius: "2px",
    },
    // Gutter change bars: widen and make solid so the changed rows read as a
    // continuous stripe down the edge (GitHub's colored gutter).
    ".cm-changeGutter": { width: "4px", paddingLeft: "0" },
    "&.cm-merge-a .cm-changedLineGutter, .cm-deletedLineGutter": {
      background: DEL_BAR,
    },
    "&.cm-merge-b .cm-changedLineGutter": { background: ADD_BAR },
    ".cm-inlineChangedLineGutter": { background: ADD_BAR },
  },
  { dark: true }
);

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
    diffTheme,
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

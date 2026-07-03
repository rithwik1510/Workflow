// src/codemirror/setup.ts — build a CodeMirror EditorView with our defaults.
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete";
import {
  bracketMatching,
  defaultHighlightStyle,
  foldGutter,
  foldKeymap,
  indentOnInput,
  syntaxHighlighting,
} from "@codemirror/language";
import { highlightSelectionMatches, search, searchKeymap } from "@codemirror/search";
import { EditorState, type EditorSelection, type Extension } from "@codemirror/state";
import {
  drawSelection,
  dropCursor,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
} from "@codemirror/view";

import { languageCompartment } from "@/codemirror/languages";
import { lumeTheme } from "@/codemirror/theme";

export interface BuildEditorOptions {
  parent: HTMLElement;
  doc: string;
  readOnly?: boolean;
  lineNumbersOn?: boolean;
  selection?: EditorSelection;
  onChange?: (doc: string) => void;
}

export function buildEditor(opts: BuildEditorOptions): EditorView {
  const extensions: Extension[] = [
    highlightSpecialChars(),
    history(),
    drawSelection(),
    dropCursor(),
    EditorState.allowMultipleSelections.of(true),
    indentOnInput(),
    bracketMatching(),
    closeBrackets(),
    syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
    search({ top: true }),
    highlightSelectionMatches(),
    highlightActiveLine(),
    keymap.of([
      ...closeBracketsKeymap,
      ...searchKeymap,
      ...foldKeymap,
      ...defaultKeymap,
      ...historyKeymap,
    ]),
    // Empty until MdEditor resolves the file's grammar (lazy — see
    // languages.ts) and reconfigures this compartment in place.
    languageCompartment.of([]),
    lumeTheme,
    EditorState.readOnly.of(!!opts.readOnly),
  ];
  if (opts.lineNumbersOn) {
    extensions.unshift(lineNumbers(), foldGutter(), highlightActiveLineGutter());
  }
  if (opts.onChange) {
    extensions.push(
      EditorView.updateListener.of((u) => {
        if (u.docChanged) opts.onChange?.(u.state.doc.toString());
      })
    );
  }
  return new EditorView({
    parent: opts.parent,
    state: EditorState.create({ doc: opts.doc, selection: opts.selection, extensions }),
  });
}

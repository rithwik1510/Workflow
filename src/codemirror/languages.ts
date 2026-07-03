// Lazy per-extension CodeMirror language loading (Plan 010 §1).
//
// WHY lazy: `@codemirror/language-data` pulls a LanguageDescription for every
// supported grammar; a STATIC import parses that whole table pre-first-paint
// (the repo-audit finding this plan fixes). Here it is only ever reached via
// `import()`, so the table — and each grammar's parser — loads on demand when
// a code file is actually opened, not at app boot.
//
// The editor is built synchronously with an empty `languageCompartment`; the
// caller (MdEditor) then awaits resolveLanguageExtension and reconfigures the
// compartment in place, so highlighting streams in a frame or two after the
// text without blocking the open.

import { LanguageDescription } from "@codemirror/language";
import { Compartment, type Extension } from "@codemirror/state";

/** The slot the live language extension lives in. MdEditor reconfigures it
 *  once the (dynamically imported) grammar resolves. */
export const languageCompartment = new Compartment();

export type EditorKind = "markdown" | "code";

/** Resolve the CodeMirror language extension for a file. Markdown keeps its
 *  rich config (fenced code blocks highlighted via language-data); code files
 *  match a grammar by filename/extension. Returns `[]` (no highlighting) when
 *  the extension is unknown or a grammar fails to load — never throws. */
export async function resolveLanguageExtension(
  path: string,
  kind: EditorKind
): Promise<Extension> {
  try {
    if (kind === "markdown") {
      const [{ markdown, markdownLanguage }, { languages }] = await Promise.all([
        import("@codemirror/lang-markdown"),
        import("@codemirror/language-data"),
      ]);
      return markdown({ base: markdownLanguage, codeLanguages: languages });
    }
    const { languages } = await import("@codemirror/language-data");
    const filename = path.split(/[/\\]/).pop() ?? path;
    const desc = LanguageDescription.matchFilename(languages, filename);
    if (!desc) return [];
    const support = await desc.load();
    return support;
  } catch {
    // A missing/broken grammar must never break the editor — degrade to plain.
    return [];
  }
}

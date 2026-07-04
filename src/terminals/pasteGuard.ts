// src/terminals/pasteGuard.ts
//
// Multiline-paste guard (Plan 012). Pasting text that contains a newline into a
// terminal is dangerous: most shells EXECUTE each completed line the instant it
// arrives (bracketed-paste helps but is not universal), so a stray multi-line
// paste can run commands you never meant to. We ask first.
//
// WHY a trailing newline counts as multiline: "npm run deploy\n" is a single
// line of TEXT but the trailing \n is the Enter that runs it — exactly the
// accident we want to catch. So detection keys off "contains \n after CRLF
// normalisation", not "≥2 non-empty lines".
//
// Pure + injectable (guardedPaste takes the paste sink + confirm fn) so the
// registry can wire the real term.paste / confirmStore while tests exercise the
// whole decision matrix without a live Terminal.

import type { ConfirmRequest } from "@/store/confirmStore";

/** True when pasting `text` should prompt: it contains a newline (CRLF-safe). */
export function isMultilinePaste(text: string): boolean {
  return text.replace(/\r\n/g, "\n").includes("\n");
}

const PREVIEW_LINES = 5;

/** Build the confirm request shown before a guarded multiline paste. Preview is
 *  the first 5 content lines (monospace), with a "+N more" tail when longer. */
export function pasteConfirmRequest(text: string): ConfirmRequest {
  const normalized = text.replace(/\r\n/g, "\n");
  // A single trailing newline is the "Enter" that runs the paste, not a content
  // line — drop it so the count + preview describe what you actually see.
  const raw = normalized.split("\n");
  const lines = raw.length > 1 && raw[raw.length - 1] === "" ? raw.slice(0, -1) : raw;
  const count = lines.length;
  const shown = lines.slice(0, PREVIEW_LINES).join("\n");
  const more = count > PREVIEW_LINES ? count - PREVIEW_LINES : 0;
  return {
    title: `Paste ${count} ${count === 1 ? "line" : "lines"}?`,
    message: "This will be sent to the shell and can run immediately.",
    preview: more > 0 ? `${shown}\n… +${more} more` : shown,
    confirmLabel: "Paste",
    cancelLabel: "Cancel",
  };
}

/**
 * Guarded paste. When the guard is on and the text is multiline, ask via
 * `confirm`; only paste on approval. Single-line (or empty) text pastes
 * straight through. The text handed to `paste` is ALWAYS byte-identical to the
 * input — we never rewrite line endings on the way to the pty.
 */
export async function guardedPaste(
  text: string,
  paste: (text: string) => void,
  opts: { warnMultiline: boolean; confirm: (req: ConfirmRequest) => Promise<boolean> }
): Promise<void> {
  if (!text) return;
  if (opts.warnMultiline && isMultilinePaste(text)) {
    const ok = await opts.confirm(pasteConfirmRequest(text));
    if (!ok) return; // cancel → nothing reaches the pty
  }
  paste(text);
}

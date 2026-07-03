# Plan 012: Terminal credibility floor — search, links, paste guard

## Status

PROPOSED — drafted 2026-07-03. The three table-stakes items open since the
2026-06-09 review; every beta reviewer hits them in the first ten minutes.
Small, independent, land-one-at-a-time.

## Goal

A developer can daily-drive Lume as their terminal without missing their old
one for the basics:

1. **Ctrl+F scrollback search** in the focused pane (`@xterm/addon-search`).
2. **Clickable URLs** in output (`@xterm/addon-web-links` → OS browser).
3. **Multiline-paste guard**: pasting text with newlines into a shell prompt
   asks first (the classic "pasted 14 lines into bash and it ran 13 of them"
   footgun).

## Why this is cheap with what we already have

- Terminals are built in ONE place (`src/terminals/registry.ts`,
  `getOrCreateTerminal`) — addons load there, once per terminal, disposed
  with it.
- Paste ALREADY routes through our own Ctrl+V/Ctrl+Shift+V handler in
  registry.ts (it bypasses the native path deliberately) — the guard is an
  intercept in code we own, no xterm surgery.
- Confirm dialog + settings rows + shortcut catalog all have established
  patterns (confirmStore, SettingsModal, ShortcutsModal CATALOG).
- The keyboard listener (capture phase) already arbitrates surface-aware
  shortcuts — Ctrl+F routes to terminal search only when a terminal owns
  focus (MD editor keeps CodeMirror's own find).

## Design

- **Search UI**: slim overlay bar top-right of the focused pane (input +
  prev/next + match count + close), same overlay grammar as the resume
  banner: absolute, never reflows the grid, presence-pattern in/out, var()
  fallbacks, reduced-motion safe. Enter/Shift+Enter = next/prev, Esc closes
  and returns focus to the shell. Decorations on (highlight all matches +
  active match) — verify WebGL renderer compatibility in step 1 (the addon
  supports decorations with the WebGL addon; if a conflict appears, fall
  back to no-decoration find-and-scroll, still shippable).
- **Web links**: `addon-web-links` with a custom handler → Tauri
  opener/shell open (never navigate the webview). Ctrl+click activation
  (plain click stays with the shell's mouse modes), hover underline.
- **Paste guard**: in our paste path, if text contains `\n` (>1 line):
  confirm dialog showing a preview (first ~5 lines, "+N more"), options
  Paste / Cancel. "Paste as one line" variant NOT included in v1 (scope).
  Setting "Warn on multiline paste" default ON. Single-line pastes never
  prompt. Bracketed-paste-aware shells still get the guard (the danger is
  the shell WITHOUT bracketed paste; detecting that reliably isn't possible,
  so the guard is uniform + toggleable).

## Steps

1. `@xterm/addon-search` wiring in registry (per-terminal instance) + search
   overlay component + Ctrl+F/Esc routing + ShortcutsModal row. Tests:
   routing (terminal-focused only), overlay render states.
2. `@xterm/addon-web-links` + opener handler. Test: handler invoked with the
   URL, never `window.location`.
3. Paste guard in the registry paste path + confirm copy + setting. Tests:
   newline detection matrix (CRLF/LF/trailing newline/single line), setting
   OFF bypass, cancel writes nothing to the pty.
4. Docs: DESIGN.md §7 shortcuts, README feature bullets.

## Testing gates

vitest + typecheck + build green; no Rust changes expected. Manual: search a
long `git log` scrollback; Ctrl+click a URL from an agent's output; paste a
multiline snippet into PowerShell (guard) and into the MD editor (no guard —
editor paste is not the terminal path).

## Risks

- Search decorations × WebGL renderer: verified in step 1 with the
  documented fallback.
- Ctrl+F collisions: capture-phase listener must keep letting CodeMirror's
  find win when the editor owns focus — covered by the surface-aware routing
  test.

## Out of scope

Regex search UI, search across scrollback of background panes, "paste as
one line", drag-drop file-path pasting (already handled elsewhere).

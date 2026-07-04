# Plan 012: Terminal credibility floor — search, links, paste guard

## Status

IMPLEMENTED — 2026-07-03, on a worktree branched from 011. Three commits
(search / web-links / paste-guard), gates green (tsc, 662 vitest, vite build;
no Rust touched). Originally APPROVED 2026-07-03, no open design questions.
Depends on 011 only for `prefsStore` (the paste-guard toggle lives there).

### Implementation notes

- **Opener reused, not added.** Web links open via the existing
  `src/lib/openExternal.ts` (`@tauri-apps/plugin-shell`), and `shell:allow-open`
  is already in `capabilities/default.json` — no `plugin-opener`, no new
  capability, no Rust change.
- **Search decorations: shipped WITH decorations, needs one live-GUI check.**
  `@xterm/addon-search` renders match highlights through xterm's decoration
  overlay (independent of the text renderer), so they are expected to render
  correctly under the WebGL renderer the app uses; colours are concrete
  `#RRGGBB` read off the active theme (`searchDecorations()` in registry.ts).
  This could not be visually confirmed from the headless agent — **verify in the
  running app** that highlights + the overview-ruler ticks paint without WebGL
  artifacts. If any appear, the documented fallback is a one-line change: drop
  the `decorations` field from `searchOptions()` and ship find-and-scroll only
  (still passes the floor).
- **Both addon deps** (`@xterm/addon-search` + `@xterm/addon-web-links`) landed
  in the search commit to keep the lockfile coherent; the web-links feature
  *code* is in its own commit.

## Goal

Daily-driver basics a beta reviewer checks in the first ten minutes:

1. **Ctrl+F scrollback search** in the focused pane (`@xterm/addon-search`).
2. **Ctrl+click URLs** in output (`@xterm/addon-web-links` → OS browser).
3. **Multiline-paste guard**: pasting text containing newlines into a
   terminal asks first.

## Why cheap (all integration points already ours)

- `src/terminals/registry.ts` builds every Terminal in one place — addons
  load there per-terminal and dispose with it (extend the registry record
  to hold the addon instances keyed by paneId).
- Paste ALREADY flows through our own Ctrl+V/Ctrl+Shift+V handler in
  registry.ts (native paste is deliberately bypassed) — the guard wraps
  `term.paste(text)` in code we own.
- confirmStore (async confirm), prefsStore (011), ShortcutsModal CATALOG,
  and the overlay grammar (resume banner) are established patterns.

## Detailed design

### 1. Search (Ctrl+F)

- **Addon**: one `SearchAddon` per terminal, created in registry, stored on
  the registry entry, disposed with the terminal.
- **UI**: `PaneSearchBar` overlay, top-right of the terminal pane (below
  the corner cluster), same overlay rules as PaneResumeBanner: absolute
  (never reflows the grid), presence-pattern in/out, var() fallbacks,
  reduced-motion safe, `--font-ui`. Contents: input · match counter
  ("3/17", from `onDidChangeResults`) · prev/next chevrons · close ×.
- **Keys**: Ctrl+F opens (capture-phase listener, ONLY when
  `focusedSurface === "terminal"` — the MD editor keeps CodeMirror's own
  find); Enter = next, Shift+Enter = prev, Esc closes AND returns DOM focus
  to the terminal. Typing in the input searches incrementally (debounced
  ~120 ms).
- **State**: tiny `paneSearchStore` micro-store (open + query per focused
  pane), following the splitMenu/contextMenu micro-store precedent.
- **Decorations**: `findNext(query, { decorations: { matchOverviewRuler,
  activeMatchColorOverviewRuler, matchBackground, activeMatchBackground } })`
  with LITERAL colors derived from the active xterm theme the way the
  terminal theme mapping already derives colors (xterm needs concrete hex,
  not CSS vars). VERIFY against the WebGL renderer first (step 1a) — the
  addon supports it, but if artifacts appear, ship find-and-scroll without
  decorations (still passes the floor) and note it.
- Case-insensitive default; no regex UI in v1.

### 2. Web links (Ctrl+click)

- `WebLinksAddon` per terminal with a custom activation handler → open via
  the Tauri opener (check what the app already uses for external URLs —
  updater/download links — and reuse; add `@tauri-apps/plugin-opener` +
  capability only if nothing exists). NEVER `window.open`/location (CSP,
  and the webview must never navigate).
- Activation modifier: Ctrl+click (plain click stays with the shell's own
  mouse modes — agents/TUIs use mouse reporting). Hover shows underline
  (addon default) + tooltip with the URL.
- Scheme allowlist: http/https only in v1.

### 3. Multiline-paste guard

- In registry.ts's paste path, before `term.paste(text)`:
  `text.replace(/\r\n/g, "\n")` — if it contains `\n` (i.e. ≥2 lines,
  counting a trailing newline as multiline: it EXECUTES in most shells):
  `confirmStore.confirm({...})` with a monospace preview (first 5 lines +
  "+N more", total line count in the title: "Paste 14 lines?"). Confirm →
  paste the ORIGINAL text unmodified; cancel → nothing reaches the pty.
- Pref: `warnMultilinePaste` (prefsStore, default ON) + SettingsModal row
  (Terminal section). Single-line paste never prompts, never will.
- The MD editor / QuickViewer / inputs are untouched (different paste path).

## Steps

1. (a) Search addon + WebGL verification spike-let; (b) PaneSearchBar +
   micro-store + key routing + ShortcutsModal row ("Find in terminal",
   Ctrl+F). Tests: routing matrix (terminal vs editor focus), overlay
   states, incremental search debounce, Esc focus return.
2. Web links + opener handler + capability. Test: handler receives URL and
   calls the opener client (mocked); no webview navigation path exists.
3. Paste guard + pref + Settings row. Tests: detection matrix (LF, CRLF,
   trailing-newline-only, single line, empty), pref OFF bypass, cancel
   writes nothing, confirm pastes byte-identical text.
4. Docs: DESIGN.md §7, README, CHANGELOG.

## Testing gates

vitest + typecheck + build green (no Rust expected unless the opener plugin
is new — then cargo gates too). Manual: search a long `git log`; Ctrl+click
a URL an agent printed; paste a multiline snippet into PowerShell (guard)
and into the MD editor (no guard); verify a TUI app's mouse still works
with the links addon active.

## Risks

- Search decorations × WebGL renderer → verified first, documented fallback.
- Ctrl+F inside TUIs that use Ctrl+F themselves (less common than Ctrl+D
  EOF, and search-open only steals it while the overlay is closed→opening;
  Esc hands the key back) — acceptable; document in ShortcutsModal.

## Out of scope

Regex search, cross-pane search, "paste as one line", link previews.

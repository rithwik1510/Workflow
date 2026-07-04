// Module-level registry of xterm.js Terminal instances, keyed by paneId.
// Per DESIGN.md §4 rule #2:
//   "xterm.js Terminal instances live in a module-level Map<paneId, Terminal>,
//    never in Zustand."
// And the Weekend-0 spike addendum:
//   "PTY lifecycle is keyed by paneId, NOT by React component mount/unmount."
//
// The registry is the single owner. Components ATTACH to a Terminal by
// calling `attach(paneId, hostEl)` — they don't create or destroy it.
// Lifecycle is driven by layoutStore subscription in the PTY orchestrator.

import { Terminal } from "@xterm/xterm";
import type { IDisposable, ITerminalOptions } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { SearchAddon, type ISearchOptions } from "@xterm/addon-search";
import { WebLinksAddon } from "@xterm/addon-web-links";

import { readClipboardText, writeClipboardText } from "@/lib/clipboardClient";
import { noteBell } from "@/sessions/attentionTracker";
import { xtermThemeFromCSS } from "@/lib/themes";
import { currentMonoFamily } from "@/lib/fontPairs";
import "@xterm/xterm/css/xterm.css";
import "@/styles/xterm-overrides.css";

import { registerMdLinkProvider } from "@/terminals/mdLinkProvider";
import { RendererPool } from "@/terminals/webglPool";
import { shouldRenderLive } from "@/terminals/visibility";
import { handleWebLink } from "@/terminals/webLinkHandler";
import { openExternal } from "@/lib/openExternal";
import type { PaneId } from "@/types";
import { useSettingsStore } from "@/store/settingsStore";

interface TerminalEntry {
  term: Terminal;
  fit: FitAddon;
  webgl: WebglAddon | null;
  /** Scrollback search (Ctrl+F). One per Terminal; the overlay drives it via
   *  the terminal*Search helpers below. Disposed with the Terminal. */
  search: SearchAddon;
  attachedTo: HTMLElement | null;
  linkDisposable: IDisposable | null;
}

const entries = new Map<PaneId, TerminalEntry>();

// ---------------------------------------------------------------------------
// WebGL context pool — bounds live WebGL renderers so a fleet of sessions can't
// blow past WebView2's ~16-context cap. Only visible panes hold a context;
// backgrounded panes fall back to the DOM renderer (lossless — the buffer is
// renderer-independent) and reacquire WebGL when foregrounded. The actual
// create/dispose lives here (it touches `entries` + WebglAddon); the pool is
// pure LRU bookkeeping.
// ---------------------------------------------------------------------------

/** Max simultaneous WebGL contexts. Comfortably under WebView2's ~16. */
const WEBGL_CAP = 8;

function createWebglFor(paneId: PaneId): boolean {
  const entry = entries.get(paneId);
  if (!entry) return false;
  if (entry.webgl) return true; // already active
  if (!entry.term.element) return false; // terminal not opened yet — retry on attach
  try {
    const webgl = new WebglAddon();
    webgl.onContextLoss(() => {
      try {
        webgl.dispose();
      } catch {
        // already disposed
      }
      if (entry.webgl === webgl) entry.webgl = null;
      rendererPool.noteContextLost(paneId);
    });
    entry.term.loadAddon(webgl);
    entry.webgl = webgl;
    return true;
  } catch (e) {
    try {
      entry.term.write(`\r\n\x1b[31m[webgl failed, using canvas: ${String(e)}]\x1b[0m\r\n`);
    } catch {
      // terminal not writable yet
    }
    return false;
  }
}

function disposeWebglFor(paneId: PaneId): void {
  const entry = entries.get(paneId);
  if (!entry || !entry.webgl) return;
  try {
    entry.webgl.dispose();
  } catch {
    // already disposed
  }
  entry.webgl = null;
}

const rendererPool = new RendererPool(WEBGL_CAP, {
  activate: createWebglFor,
  evict: disposeWebglFor,
});

/** Pane became visible — ensure it holds a (pooled) WebGL context. */
export function acquireRenderer(paneId: PaneId): void {
  rendererPool.acquire(paneId);
}

/** Pane went background — its context becomes evictable under cap pressure. */
export function markBackgroundRenderer(paneId: PaneId): void {
  rendererPool.markBackground(paneId);
}

/**
 * Escape sequence that turns off every xterm mouse-tracking mode we know of.
 * Used proactively on every PTY spawn (defensive against apps that exit dirty
 * and leave mouse-mode on — see Weekend 0 spike learning, DESIGN.md §7).
 */
export const MOUSE_MODE_RESET =
  "\x1b[?9l\x1b[?1000l\x1b[?1001l\x1b[?1002l\x1b[?1003l\x1b[?1004l\x1b[?1005l\x1b[?1006l\x1b[?1015l\x1b[?1016l";

/** Apply a partial option set to every live Terminal, then refit so the new
 *  cell metrics reflow correctly. */
export function applyOptionsToAll(opts: Partial<ITerminalOptions>): void {
  for (const [, entry] of entries) {
    Object.assign(entry.term.options, opts);
    if (entry.term.element) entry.fit.fit();
  }
}

/**
 * Get the Terminal for `paneId`, creating it on first access. The instance
 * persists across React mounts/unmounts of any pane component.
 */
export function getOrCreateTerminal(paneId: PaneId): Terminal {
  const existing = entries.get(paneId);
  if (existing) return existing.term;

  const cfg = useSettingsStore.getState().config;
  const term = new Terminal({
    fontFamily:
      getComputedStyle(document.documentElement).getPropertyValue("--font-mono").trim() ||
      "JetBrains Mono Variable, Consolas, monospace",
    fontSize: cfg.font.size,
    fontWeight: String(cfg.font.weight) as ITerminalOptions["fontWeight"],
    lineHeight: cfg.font.line_height,
    cursorBlink: cfg.terminal.cursor_blink,
    cursorStyle: cfg.terminal.cursor_style,
    // Theme is derived from the active CSS variables (which the App-level
    // theme effect sets via data-theme on :root). When the user switches
    // themes, applyXtermThemeToAll() walks the registry and re-applies.
    theme: xtermThemeFromCSS(),
    scrollback: cfg.terminal.scrollback_lines,
    allowProposedApi: true,
  });

  // Terminal copy/paste — xterm doesn't wire the clipboard itself.
  //   Ctrl+Shift+C       → always copy the current selection.
  //   Ctrl+C             → copy IF something is selected, then clear it;
  //                        with no selection it falls through as SIGINT so it
  //                        can still interrupt the running program. This is
  //                        what Windows Terminal / VS Code do, and it's the
  //                        ergonomic default people expect.
  //   Ctrl+V / Ctrl+Shift+V → paste (both, matching Windows Terminal).
  // Note: inside a mouse-reporting TUI (Claude Code, Codex, vim, …) the app
  // owns the mouse, so a plain drag never makes a selection xterm can see —
  // hold Shift while dragging to force-select first (xterm's shiftKey
  // override), then copy.
  // We preventDefault + return false so the key is fully consumed: no
  // double-paste from the webview's native paste handler, and the keystroke
  // never leaks into the shell. term.paste() routes through the onData wire
  // to the PTY (and respects bracketed-paste mode).
  term.attachCustomKeyEventHandler((e) => {
    if (e.type !== "keydown") return true;
    if (!e.ctrlKey || e.altKey || e.metaKey) return true;
    const key = e.key.toLowerCase();
    if (key === "c") {
      const selection = term.getSelection();
      // Plain Ctrl+C with no selection → let it through as SIGINT.
      if (!e.shiftKey && !selection) return true;
      if (selection) {
        void writeClipboardText(selection);
        term.clearSelection();
      }
      e.preventDefault();
      return false;
    }
    if (key === "v") {
      e.preventDefault();
      void readClipboardText().then((text) => {
        if (text) term.paste(text);
      });
      return false;
    }
    return true;
  });

  // Terminal bell → attention cue. Agents/shells ring the bell (BEL) on
  // completion or when they block for input; if this is a background session
  // the tracker glows its sidebar dot. Disposed with the Terminal.
  term.onBell(() => noteBell(paneId));

  const fit = new FitAddon();
  term.loadAddon(fit);

  // Scrollback search (Ctrl+F). Highlight cap keeps a pathological query
  // ("e" over 100k lines) from decorating the whole buffer.
  const search = new SearchAddon({ highlightLimit: 2000 });
  term.loadAddon(search);

  // Web links — Ctrl+click an http(s) URL in output to open it in the OS
  // browser. Plain click stays with the shell's mouse modes (see
  // webLinkHandler.ts). Never navigates the webview. Disposed with the
  // Terminal by xterm's addon manager.
  const webLinks = new WebLinksAddon(
    (event, uri) => handleWebLink(event, uri, (url) => void openExternal(url)),
    { urlRegex: HTTP_URL_REGEX }
  );
  term.loadAddon(webLinks);

  entries.set(paneId, {
    term,
    fit,
    webgl: null,
    search,
    attachedTo: null,
    linkDisposable: null,
  });
  return term;
}

/**
 * URL matcher for the web-links addon — http/https only (Plan 012). The addon's
 * default regex also underlines ftp/file/… which our handler refuses to open;
 * scoping it here means only openable links get the hover-underline affordance.
 * Kept intentionally close to the addon's own pattern (no trailing punctuation).
 */
const HTTP_URL_REGEX =
  /https?:\/\/[\w\-@;/?:&=%$.+!*'(),~#]+[\w\-@;/?:&=%$+*~#]/;

/** Concrete #RRGGBB search-highlight colours derived from the ACTIVE theme —
 *  xterm decorations require literal hex (matchBackground: "must use #RRGGBB"),
 *  not CSS vars. Mirrors xtermThemeFromCSS's read-off-:root approach so search
 *  highlights track theme switches. */
function searchDecorations(): ISearchOptions["decorations"] {
  const css = getComputedStyle(document.documentElement);
  const read = (name: string, fallback: string): string => {
    const v = css.getPropertyValue(name).trim();
    return /^#[0-9a-fA-F]{6}$/.test(v) ? v : fallback;
  };
  const match = read("--accent-dim", "#2f7adc");
  const active = read("--accent", "#5fa8ff");
  return {
    matchBackground: match,
    matchOverviewRuler: match,
    activeMatchBackground: active,
    activeMatchColorOverviewRuler: active,
  };
}

/** Shared search options: case-insensitive, decorations from the active theme. */
function searchOptions(extra?: Partial<ISearchOptions>): ISearchOptions {
  return { caseSensitive: false, decorations: searchDecorations(), ...extra };
}

/** Find the next match of `query` in the pane's scrollback (Ctrl+F / Enter).
 *  `incremental` expands the current selection while the user is still typing. */
export function terminalFindNext(
  paneId: PaneId,
  query: string,
  opts?: { incremental?: boolean }
): boolean {
  const entry = entries.get(paneId);
  if (!entry) return false;
  return entry.search.findNext(query, searchOptions({ incremental: opts?.incremental }));
}

/** Find the previous match (Shift+Enter). */
export function terminalFindPrevious(paneId: PaneId, query: string): boolean {
  const entry = entries.get(paneId);
  if (!entry) return false;
  return entry.search.findPrevious(query, searchOptions());
}

/** Clear all search highlights + the active-match decoration (bar closed). */
export function clearTerminalSearch(paneId: PaneId): void {
  const entry = entries.get(paneId);
  if (!entry) return;
  entry.search.clearDecorations();
}

/** Subscribe to the addon's match-count changes (feeds the "3/17" counter).
 *  Returns null when the pane has no Terminal yet. */
export function onTerminalSearchResults(
  paneId: PaneId,
  handler: (results: { resultIndex: number; resultCount: number }) => void
): IDisposable | null {
  const entry = entries.get(paneId);
  if (!entry) return null;
  return entry.search.onDidChangeResults(handler);
}

/**
 * Attach a previously-created Terminal to a DOM container.
 *
 * Three paths, gated on whether xterm has been opened before. We key off
 * `term.element` (xterm-internal: null before open(), a real DOM node
 * after) because it's the canonical "has open() ever been called?" signal.
 * Earlier this function gated on `entry.attachedTo`, but detach() sets
 * that to null — meaning after a detach/remount cycle the code fell
 * through to Path 3 and called open() a second time. xterm.js silently
 * breaks rendering when you do that: writes still happen internally but
 * nothing reaches the canvas/WebGL surface. Result: a blank black pane.
 *
 *   1. Same host as before → re-fit.
 *   2. Already opened (term.element exists) but in a different host →
 *      MOVE the xterm root via appendChild. Never call open() again.
 *   3. First-ever open → term.open(host) + WebGL init.
 *
 * Returns true if WebGL initialised, false if it threw and we're on the
 * canvas fallback. The Terminal is usable either way.
 */
export function attach(paneId: PaneId, host: HTMLElement): boolean {
  const entry = entries.get(paneId);
  if (!entry) throw new Error(`no terminal for paneId=${paneId}`);

  if (entry.attachedTo === host) {
    // Path 1: same host.
    entry.fit.fit();
  } else if (entry.term.element) {
    // Path 2: xterm has been opened before. Reparent — DO NOT reopen.
    // term.element is the xterm.js-internal root; it's null until open()
    // has been called once, and a real DOM node after. This check survives
    // any number of detach/remount cycles because it doesn't depend on our
    // own `attachedTo` bookkeeping. (Reopening silently breaks rendering.)
    host.appendChild(entry.term.element);
    entry.attachedTo = host;
    entry.fit.fit();
  } else {
    // Path 3: first-ever open for this Terminal.
    entry.term.open(host);
    entry.attachedTo = host;
    // Register the MD-link provider exactly once per Terminal instance, on
    // the first-mount path. Reparent (Path 2) doesn't re-register — the
    // provider is bound to the Terminal, not the DOM host.
    entry.linkDisposable = registerMdLinkProvider(entry.term, paneId);
    entry.fit.fit();
  }

  // WebGL is governed centrally by the pool. A visible pane gets a context now
  // (created lazily — same try/catch as before); a hidden pane uses the DOM
  // renderer until it's foregrounded. The empty-visible-set fail-safe in
  // shouldRenderLive means a missing/uninstalled governor treats every pane as
  // visible, i.e. identical to the old "every pane gets WebGL" behavior.
  if (shouldRenderLive(paneId)) acquireRenderer(paneId);

  return entry.webgl !== null;
}

/** Drop the attachment without disposing the Terminal. */
export function detach(paneId: PaneId): void {
  const entry = entries.get(paneId);
  if (!entry) return;
  entry.attachedTo = null;
  // Note: xterm doesn't expose a "close without dispose" — but reattaching
  // via open() against a new element works for our case. The next attach
  // call will move it.
}

/** Fully dispose a Terminal and remove its entry. Called from the PTY orchestrator. */
export function disposeTerminal(paneId: PaneId): void {
  const entry = entries.get(paneId);
  if (!entry) return;
  try {
    entry.linkDisposable?.dispose();
  } catch {
    // ignore
  }
  try {
    entry.webgl?.dispose();
  } catch {
    // ignore
  }
  entry.term.dispose();
  entries.delete(paneId);
  rendererPool.forget(paneId);
}

/** Resize hook — called from window resize or splitter drag. */
export function fitTerminal(paneId: PaneId): { cols: number; rows: number } | null {
  const entry = entries.get(paneId);
  if (!entry) return null;
  entry.fit.fit();
  return { cols: entry.term.cols, rows: entry.term.rows };
}

/** Direct write to xterm — bypasses any store. Used by the PTY data sink. */
export function writeToTerminal(paneId: PaneId, bytes: Uint8Array): void {
  const entry = entries.get(paneId);
  if (!entry) return;
  entry.term.write(bytes);
}

/** Hook into xterm's input event — keystrokes typed in the focused Terminal. */
export function onTerminalData(
  paneId: PaneId,
  handler: (data: string) => void
): { dispose(): void } {
  const entry = entries.get(paneId);
  if (!entry) throw new Error(`no terminal for paneId=${paneId}`);
  return entry.term.onData(handler);
}

/** Send the mouse-mode-reset escape sequences to xterm itself (not the PTY). */
export function resetMouseModes(paneId: PaneId): void {
  const entry = entries.get(paneId);
  if (!entry) return;
  entry.term.write(MOUSE_MODE_RESET);
}

/** Focus the terminal — pulls focus into the textarea xterm renders. */
export function focusTerminal(paneId: PaneId): void {
  entries.get(paneId)?.term.focus();
}

/** Test-only: nuke the registry. */
export function __resetRegistry(): void {
  for (const id of Array.from(entries.keys())) disposeTerminal(id);
}

/**
 * Re-apply the active CSS-driven xterm theme to every live Terminal.
 * Called after a theme switch (App's theme effect sets data-theme on
 * :root, then calls this so the WebGL atlas re-renders against the new
 * palette). xterm regenerates its glyph atlas on theme assignment — a
 * one-frame flash, acknowledged in DESIGN.md §10 risk #9.
 */
export function applyXtermThemeToAll(): void {
  const theme = xtermThemeFromCSS();
  for (const entry of entries.values()) {
    entry.term.options.theme = theme;
  }
}

/**
 * Push the currently-active --font-mono stack to every live Terminal and
 * re-fit so the new cell metrics reflow correctly. Called after the user
 * switches the font pair — the CSS variable has already been swapped by
 * the App-level data-font-pair effect, but xterm caches its own
 * fontFamily option per Terminal and won't notice without an explicit
 * assignment.
 */
export function applyXtermFontFamilyToAll(): void {
  const fontFamily = currentMonoFamily();
  applyOptionsToAll({ fontFamily });
}

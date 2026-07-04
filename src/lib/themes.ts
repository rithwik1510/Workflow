// Theme registry — the small set of named themes available in v0.2.
//
// CSS palettes live in src/styles/theme.css under :root[data-theme="<name>"].
// This module just owns the canonical list, the default, a guard, and a
// helper that derives the xterm.js theme object from the *active* CSS
// variables — that way xterm always matches whatever palette the CSS layer
// is currently rendering, and we don't double-author colours.

import type { ITheme } from "@xterm/xterm";

export const THEME_NAMES = ["cobalt", "coral", "tokyo", "gruvbox", "nocturne"] as const;
export type ThemeName = (typeof THEME_NAMES)[number];

export const DEFAULT_THEME: ThemeName = "cobalt";

/** Narrow an arbitrary string (e.g. from config.toml) to a known theme.
 *  Falls back to DEFAULT_THEME when the string isn't recognised — keeps
 *  the app from black-screening if someone hand-edits an unknown value. */
export function coerceThemeName(value: string | null | undefined): ThemeName {
  if (value && (THEME_NAMES as readonly string[]).includes(value)) {
    return value as ThemeName;
  }
  return DEFAULT_THEME;
}

/** Read the active palette directly off :root's CSS variables and return
 *  an xterm.js ITheme. Call this AFTER setting `data-theme` so the values
 *  reflect the new theme. */
export function xtermThemeFromCSS(): ITheme {
  const css = getComputedStyle(document.documentElement);
  const read = (name: string, fallback: string): string => {
    const v = css.getPropertyValue(name).trim();
    return v.length > 0 ? v : fallback;
  };
  return {
    background: read("--bg-0", "#0a0a0a"),
    foreground: read("--fg-0", "#e6e6e6"),
    cursor: read("--accent", "#5fa8ff"),
    cursorAccent: read("--bg-0", "#0a0a0a"),
    selectionBackground: read("--accent-alpha", "rgba(95,168,255,0.3)"),
    black: read("--bg-0", "#0a0a0a"),
    red: read("--error", "#e85a5a"),
    green: read("--success", "#7fc26b"),
    yellow: read("--accent-dim", "#2f7adc"),
    blue: read("--accent", "#5fa8ff"),
    magenta: "#c792ea",
    cyan: "#7dcfff",
    white: read("--fg-0", "#e6e6e6"),
    brightBlack: read("--fg-3", "#4a4a4a"),
    brightRed: read("--error", "#e85a5a"),
    brightGreen: read("--success", "#7fc26b"),
    brightYellow: read("--accent", "#5fa8ff"),
    brightBlue: read("--accent", "#5fa8ff"),
    brightMagenta: "#d7a6ff",
    brightCyan: "#9be7ff",
    brightWhite: read("--fg-heading", "#ffffff"),
  };
}

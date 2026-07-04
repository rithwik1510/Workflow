// src/types/config.ts
//
// Mirror of src-tauri/src/config.rs LumeConfig. Field names and
// nesting must match exactly — TOML ↔ serde ↔ JSON ↔ this type.
// If you change one side, change the other.

export interface FontConfig {
  family: string;
  size: number;
  weight: number;       // 300 | 400 | 500 | 600
  line_height: number;  // 1.0 – 2.0
  // Named font pair from src/lib/fontPairs.ts. Drives both --font-ui and
  // --font-mono. `family` above remains for back-compat / future override but
  // the pair is the primary surface in the Settings panel.
  pair: "modern" | "geist" | "plex" | "system";
}

export interface TerminalConfig {
  scrollback_lines: number;
  ipc_batch_ms: number;
  ring_buffer_mb: number;
  cursor_style: "bar" | "block" | "underline";
  cursor_blink: boolean;
}

export interface MdEditorConfig {
  soft_wrap: boolean;
  line_numbers: boolean;
  indent_spaces: number;
  trim_trailing_whitespace_on_save: boolean;
  default_mode: "view" | "edit";
}

export interface QuickViewerConfig {
  width_pct: number;
}

export interface SidebarConfig {
  visible: boolean;
  collapsed_dirs: string[];
}

// `accent` names a curated theme from src/lib/themes.ts. Field name stays
// `accent` for config.toml back-compat — older configs that say `accent =
// "amber"` won't fail to parse (the Rust side keeps it as String); unknown
// values fall back to the default theme at apply time.
export interface ThemeConfig {
  accent: "cobalt" | "coral" | "tokyo" | "gruvbox" | "nocturne";
}

export interface LogConfig {
  level: "debug" | "info" | "warn" | "error";
  path: string;
}

export interface LumeConfig {
  default_shell: string;
  font: FontConfig;
  terminal: TerminalConfig;
  md_editor: MdEditorConfig;
  quick_viewer: QuickViewerConfig;
  sidebar: SidebarConfig;
  theme: ThemeConfig;
  log: LogConfig;
}

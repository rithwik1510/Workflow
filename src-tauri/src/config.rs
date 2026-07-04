// src-tauri/src/config.rs
//
// Lume config.toml schema, default generation, parse, file watch.
// Path: dirs::config_dir().join("lume/config.toml")
//   Windows: %APPDATA%\lume\config.toml
//   macOS:   ~/Library/Application Support/lume/config.toml
//   Linux:   ~/.config/lume/config.toml
//
// Schema lives in DESIGN.md §6. Unknown keys are logged at WARN level and
// then ignored — they do not abort the load (matches DESIGN.md §6 "Unknown
// keys produce a warn toast but don't break the load"). Toast surface is
// deferred to a later weekend; logging is the durable record until then.

// `Config as NotifyConfig` rename avoids a name collision with our own
// `LumeConfig` in this module — keeping notify's type accessible
// under a distinct alias.
use notify::{
    Config as NotifyConfig, Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher,
};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tauri::ipc::Channel;
use tauri::State;
use toml_edit::{value as toml_value, DocumentMut, Item, Table};

use crate::error::{AppError, AppResult};

// Trailing-edge debounce window for config.toml hot-reload. VS Code /
// Sublime / nvim each generate 2-5 raw events for a single save; we
// collapse a burst into one emission ~DEBOUNCE_MS after the LAST event.
const DEBOUNCE_MS: u64 = 150;

fn default_font_weight() -> u32 {
    400
}
fn default_line_height() -> f64 {
    1.2
}
fn default_cursor_style() -> String {
    "block".to_string()
}
fn default_cursor_blink() -> bool {
    true
}
fn default_font_pair() -> String {
    "modern".to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct FontConfig {
    pub family: String,
    pub size: u32,
    #[serde(default = "default_font_weight")]
    pub weight: u32,
    #[serde(default = "default_line_height")]
    pub line_height: f64,
    // Named font pair from src/lib/fontPairs.ts. Drives both UI and mono via
    // data-font-pair on :root. Defaulted via serde so older configs (without
    // this field) deserialize cleanly; unknown values are coerced back to the
    // default on the JS side.
    #[serde(default = "default_font_pair")]
    pub pair: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct TerminalConfig {
    pub scrollback_lines: u32,
    pub ipc_batch_ms: u32,
    pub ring_buffer_mb: u32,
    #[serde(default = "default_cursor_style")]
    pub cursor_style: String,
    #[serde(default = "default_cursor_blink")]
    pub cursor_blink: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct MdEditorConfig {
    pub soft_wrap: bool,
    pub line_numbers: bool,
    pub indent_spaces: u32,
    pub trim_trailing_whitespace_on_save: bool,
    pub default_mode: String, // "view" | "edit"
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct QuickViewerConfig {
    pub width_pct: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct SidebarConfig {
    pub visible: bool,
    pub collapsed_dirs: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct ThemeConfig {
    // Curated theme name from src/lib/themes.ts. v0.2 ships:
    //   "cobalt" (default), "coral", "tokyo", "gruvbox", "nocturne"
    // Kept as a String (not an enum) so an unknown legacy value like
    // "amber" still parses cleanly; the JS layer coerces unknown names
    // back to the default theme at apply time.
    pub accent: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct LogConfig {
    pub level: String,
    pub path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct LumeConfig {
    pub default_shell: String,
    pub font: FontConfig,
    pub terminal: TerminalConfig,
    pub md_editor: MdEditorConfig,
    pub quick_viewer: QuickViewerConfig,
    pub sidebar: SidebarConfig,
    pub theme: ThemeConfig,
    pub log: LogConfig,
    // [keybindings] intentionally untyped — empty table by default. Future
    // expansion lands once we have a keybinding resolver in place.
}

impl Default for LumeConfig {
    fn default() -> Self {
        Self {
            default_shell: "pwsh".to_string(),
            font: FontConfig {
                family: "JetBrains Mono".to_string(),
                size: 14,
                weight: 400,
                line_height: 1.2,
                pair: "modern".to_string(),
            },
            terminal: TerminalConfig {
                scrollback_lines: 10_000,
                ipc_batch_ms: 32,
                ring_buffer_mb: 8,
                cursor_style: "block".to_string(),
                cursor_blink: true,
            },
            md_editor: MdEditorConfig {
                soft_wrap: true,
                line_numbers: true,
                indent_spaces: 2,
                trim_trailing_whitespace_on_save: true,
                default_mode: "view".to_string(),
            },
            quick_viewer: QuickViewerConfig { width_pct: 25 },
            sidebar: SidebarConfig {
                visible: true,
                collapsed_dirs: vec![
                    "node_modules".into(),
                    ".git".into(),
                    "__pycache__".into(),
                    "target".into(),
                    "dist".into(),
                    "build".into(),
                    ".venv".into(),
                    ".next".into(),
                    ".turbo".into(),
                    ".cache".into(),
                ],
            },
            theme: ThemeConfig {
                accent: "cobalt".to_string(),
            },
            log: LogConfig {
                level: "info".to_string(),
                path: "%LOCALAPPDATA%\\lume\\logs".to_string(),
            },
        }
    }
}

const DEFAULT_TOML: &str = r#"# Lume config — edit this file directly; changes hot-reload.
# Full schema is documented in DESIGN.md §6.
default_shell = "pwsh"

[font]
family = "JetBrains Mono"
size = 14
weight = 400              # 300 | 400 | 500 | 600
line_height = 1.2         # 1.0 – 2.0
pair = "modern"           # "modern" | "geist" | "plex" | "system"

[terminal]
scrollback_lines = 10000
ipc_batch_ms = 32
ring_buffer_mb = 8
cursor_style = "block"    # "bar" | "block" | "underline"
cursor_blink = true

[md_editor]
soft_wrap = true
line_numbers = true
indent_spaces = 2
trim_trailing_whitespace_on_save = true
default_mode = "view"

[quick_viewer]
width_pct = 25

[sidebar]
visible = true
collapsed_dirs = [
  "node_modules",
  ".git",
  "__pycache__",
  "target",
  "dist",
  "build",
  ".venv",
  ".next",
  ".turbo",
  ".cache",
]

[theme]
# One of: "cobalt" (default), "coral", "tokyo", "gruvbox", "nocturne"
accent = "cobalt"

[log]
level = "info"
path = "%LOCALAPPDATA%\\lume\\logs"

[keybindings]
# Override any key from DESIGN.md §7. Example:
# split_right = "Ctrl+\\"
"#;

pub fn config_dir() -> AppResult<PathBuf> {
    dirs::config_dir()
        .map(|p| p.join("lume"))
        .ok_or_else(|| AppError::internal("config_dir unavailable"))
}

pub fn config_path() -> AppResult<PathBuf> {
    Ok(config_dir()?.join("config.toml"))
}

#[tauri::command]
pub fn config_file_path() -> AppResult<String> {
    Ok(config_path()?.to_string_lossy().to_string())
}

/// Inner helper that operates on an explicit path. Testable without
/// touching the user's real config dir.
fn write_default_at(path: &std::path::Path) -> AppResult<bool> {
    if path.exists() {
        return Ok(false);
    }
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| {
            AppError::internal(format!("create_dir_all {}: {}", parent.display(), e))
        })?;
    }
    std::fs::write(path, DEFAULT_TOML)
        .map_err(|e| AppError::internal(format!("write default {}: {}", path.display(), e)))?;
    log::info!("config.toml created at {}", path.display());
    Ok(true)
}

#[tauri::command]
pub fn write_default_config_if_missing() -> AppResult<bool> {
    write_default_at(&config_path()?)
}

#[tauri::command]
pub fn read_config() -> AppResult<LumeConfig> {
    let path = config_path()?;
    if !path.exists() {
        log::info!("config.toml missing; returning defaults (file not created here)");
        return Ok(LumeConfig::default());
    }
    let text = std::fs::read_to_string(&path)
        .map_err(|e| AppError::internal(format!("read {}: {}", path.display(), e)))?;
    parse_config_or_default(&text)
}

/// Logs a WARN for every key at the top level of `value` that is not in
/// the known schema. Doesn't fail — purely advisory output.
fn warn_unknown_top_level(value: &toml::Value) {
    const KNOWN: &[&str] = &[
        "default_shell",
        "font",
        "terminal",
        "md_editor",
        "quick_viewer",
        "sidebar",
        "theme",
        "log",
        "keybindings",
    ];
    if let toml::Value::Table(t) = value {
        for k in t.keys() {
            if !KNOWN.contains(&k.as_str()) {
                log::warn!("config.toml: unknown top-level key '{}' (ignored)", k);
            }
        }
    }
}

/// Parse a TOML string into a LumeConfig.
/// - Returns `Err` if the TOML is syntactically invalid (the caller may
///   surface this to the user).
/// - Returns `Ok(default)` if the TOML parses but fails strict schema
///   validation (unknown keys inside known sub-tables, type mismatches,
///   etc.); these are logged at WARN level so they can be diagnosed but
///   don't break the load (DESIGN.md §6 "Invalid values fall back to
///   last-known-valid config" — the JS layer's revertToLastValid handles
///   the "last-known-valid" half via lastValidConfig).
/// - Returns `Ok(parsed)` on success.
///
/// Also emits a WARN for every unknown TOP-LEVEL key encountered.
fn parse_config_or_default(text: &str) -> AppResult<LumeConfig> {
    let value: toml::Value =
        toml::from_str(text).map_err(|e| AppError::internal(format!("toml parse: {}", e)))?;
    warn_unknown_top_level(&value);
    match toml::from_str::<LumeConfig>(text) {
        Ok(cfg) => Ok(cfg),
        Err(e) => {
            log::warn!("config.toml: strict parse failed ({}); using defaults", e);
            Ok(LumeConfig::default())
        }
    }
}

// ----- Format-preserving config editing -----

const WRITABLE_ROOTS: &[&str] = &[
    "default_shell",
    "font",
    "terminal",
    "md_editor",
    "quick_viewer",
    "sidebar",
    "theme",
    "log",
];

fn json_to_toml(v: &serde_json::Value) -> AppResult<toml_edit::Value> {
    use serde_json::Value as J;
    Ok(match v {
        J::Bool(b) => toml_value(*b).into_value().unwrap(),
        J::Number(n) if n.is_i64() => toml_value(n.as_i64().unwrap()).into_value().unwrap(),
        J::Number(n) if n.is_u64() => {
            let v = n
                .as_u64()
                .ok_or_else(|| AppError::internal("config value not an integer"))?;
            let v =
                i64::try_from(v).map_err(|_| AppError::internal("config integer out of range"))?;
            toml_value(v).into_value().unwrap()
        }
        J::Number(n) => toml_value(n.as_f64().unwrap()).into_value().unwrap(),
        J::String(s) => toml_value(s.clone()).into_value().unwrap(),
        J::Array(items) => {
            let mut arr = toml_edit::Array::new();
            for it in items {
                match it {
                    J::String(s) => arr.push(s.as_str()),
                    _ => return Err(AppError::internal("array items must be strings")),
                }
            }
            toml_edit::Value::Array(arr)
        }
        J::Null | J::Object(_) => return Err(AppError::internal("unsupported config value shape")),
    })
}

fn apply_config_edit(text: &str, path: &str, value: serde_json::Value) -> AppResult<String> {
    let segments: Vec<&str> = path.split('.').collect();
    let root = *segments
        .first()
        .ok_or_else(|| AppError::internal("empty config path"))?;
    if !WRITABLE_ROOTS.contains(&root) {
        return Err(AppError::internal(format!(
            "config path not writable: {path}"
        )));
    }
    let mut doc = text
        .parse::<DocumentMut>()
        .map_err(|e| AppError::internal(format!("parse config.toml: {e}")))?;
    let leaf = json_to_toml(&value)?;
    if segments.len() == 1 {
        doc[root] = Item::Value(leaf);
        return Ok(doc.to_string());
    }
    let mut tbl: &mut Table = doc.as_table_mut();
    for seg in &segments[..segments.len() - 1] {
        let entry = tbl.entry(seg).or_insert(Item::Table(Table::new()));
        tbl = entry
            .as_table_mut()
            .ok_or_else(|| AppError::internal(format!("config segment not a table: {seg}")))?;
    }
    let last = segments[segments.len() - 1];
    tbl[last] = Item::Value(leaf);
    Ok(doc.to_string())
}

#[tauri::command]
pub fn set_config_value(path: String, value: serde_json::Value) -> AppResult<()> {
    let p = config_path()?;
    write_default_at(&p)?; // no-op if present; ensures a file to edit
    let text = std::fs::read_to_string(&p)
        .map_err(|e| AppError::internal(format!("read {}: {}", p.display(), e)))?;
    let updated = apply_config_edit(&text, &path, value)?;
    std::fs::write(&p, updated)
        .map_err(|e| AppError::internal(format!("write {}: {}", p.display(), e)))?;
    Ok(())
}

// ----- Hot reload -----

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ConfigEvent {
    /// The file changed on disk. Caller should call `read_config` to fetch
    /// the new value. Includes the path that changed for sanity.
    Changed { path: String },
}

#[derive(Default)]
pub struct ConfigWatcherState(pub Mutex<Option<RecommendedWatcher>>);

#[tauri::command]
pub fn watch_config(
    state: State<'_, ConfigWatcherState>,
    channel: Channel<ConfigEvent>,
) -> AppResult<()> {
    let path = config_path()?;
    let dir = config_dir()?;
    // We watch the directory (not just the file) — many editors save by
    // writing to a temp file and renaming, which `notify` reports as a
    // Remove + Create on the target rather than Modify. Watching the dir
    // catches both shapes.
    std::fs::create_dir_all(&dir)
        .map_err(|e| AppError::internal(format!("create_dir_all {}: {}", dir.display(), e)))?;

    let channel = Arc::new(channel);
    let chan_clone = channel.clone();
    let target = path.clone();
    // Trailing-edge debounce: emit once ~DEBOUNCE_MS after the LAST event
    // in a burst. VS Code / Sublime / nvim each generate 2-5 raw events
    // for one save; the previous leading-edge logic emitted on the FIRST
    // event and suppressed the rest, which could drop the final state if
    // the JS handler re-read mid-write. Now: each event updates
    // `last_event_at`, and a SINGLE dispatcher thread (guarded by the
    // `dispatcher_armed` flag) wakes after DEBOUNCE_MS, re-checks the
    // latest timestamp, and either emits or loops.
    let last_event_at: Arc<Mutex<Instant>> = Arc::new(Mutex::new(Instant::now()));
    let dispatcher_armed: Arc<std::sync::atomic::AtomicBool> =
        Arc::new(std::sync::atomic::AtomicBool::new(false));

    let mut watcher = notify::recommended_watcher(move |res: notify::Result<Event>| {
        if let Ok(event) = res {
            if !matches!(
                event.kind,
                EventKind::Create(_) | EventKind::Modify(_) | EventKind::Remove(_)
            ) {
                return;
            }
            if !event.paths.iter().any(|p| p == &target) {
                return;
            }
            {
                let mut t = last_event_at.lock();
                *t = Instant::now();
            }
            if !dispatcher_armed.swap(true, std::sync::atomic::Ordering::SeqCst) {
                let last_event_at = last_event_at.clone();
                let dispatcher_armed = dispatcher_armed.clone();
                let chan_clone = chan_clone.clone();
                let target = target.clone();
                std::thread::spawn(move || {
                    loop {
                        std::thread::sleep(Duration::from_millis(DEBOUNCE_MS));
                        let elapsed = {
                            let t = last_event_at.lock();
                            t.elapsed()
                        };
                        if elapsed >= Duration::from_millis(DEBOUNCE_MS) {
                            break;
                        }
                    }
                    dispatcher_armed.store(false, std::sync::atomic::Ordering::SeqCst);
                    let _ = chan_clone.send(ConfigEvent::Changed {
                        path: target.to_string_lossy().to_string(),
                    });
                });
            }
        }
    })
    .map_err(|e| AppError::internal(format!("config watcher create: {}", e)))?;

    watcher
        .configure(NotifyConfig::default().with_compare_contents(false))
        .map_err(|e| AppError::internal(format!("config watcher config: {}", e)))?;
    watcher
        .watch(&dir, RecursiveMode::NonRecursive)
        .map_err(|e| AppError::internal(format!("watch {}: {}", dir.display(), e)))?;

    *state.0.lock() = Some(watcher);
    Ok(())
}

// ----- Tests -----

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn default_toml_round_trips() {
        let cfg: LumeConfig = toml::from_str(DEFAULT_TOML).expect("parse default toml");
        assert_eq!(cfg, LumeConfig::default());
    }

    #[test]
    fn parse_with_unknown_top_level_key_falls_back() {
        let text = r#"
        default_shell = "pwsh"
        unknown_key = "ignored"

        [font]
        family = "Inter"
        size = 13

        [terminal]
        scrollback_lines = 1000
        ipc_batch_ms = 16
        ring_buffer_mb = 4

        [md_editor]
        soft_wrap = true
        line_numbers = false
        indent_spaces = 4
        trim_trailing_whitespace_on_save = false
        default_mode = "edit"

        [quick_viewer]
        width_pct = 30

        [sidebar]
        visible = false
        collapsed_dirs = []

        [theme]
        accent = "cobalt"

        [log]
        level = "debug"
        path = "/tmp"
        "#;
        // Strict parse fails because unknown_key is at top level and the
        // top-level struct does NOT use deny_unknown_fields. So actually
        // this should SUCCEED with the field ignored. Verify:
        let cfg = parse_config_or_default(text).expect("parse");
        assert_eq!(cfg.default_shell, "pwsh");
        assert_eq!(cfg.font.family, "Inter");
        assert_eq!(cfg.md_editor.default_mode, "edit");
    }

    #[test]
    fn parse_with_garbage_falls_back_to_defaults() {
        let text = "this is not valid toml === = =";
        let result = parse_config_or_default(text);
        // First pass (toml::from_str into Value) fails, which is an Err.
        assert!(result.is_err());
    }

    #[test]
    fn parse_with_strict_failure_falls_back_to_defaults() {
        // Valid TOML but the sub-table has an unknown field.
        let text = r#"
        default_shell = "pwsh"

        [font]
        family = "Inter"
        size = 13
        weirdfield = "?"

        [terminal]
        scrollback_lines = 1000
        ipc_batch_ms = 16
        ring_buffer_mb = 4

        [md_editor]
        soft_wrap = true
        line_numbers = false
        indent_spaces = 4
        trim_trailing_whitespace_on_save = false
        default_mode = "view"

        [quick_viewer]
        width_pct = 30

        [sidebar]
        visible = true
        collapsed_dirs = []

        [theme]
        accent = "cobalt"

        [log]
        level = "debug"
        path = "/tmp"
        "#;
        let cfg = parse_config_or_default(text).expect("falls back");
        assert_eq!(cfg, LumeConfig::default());
    }

    #[test]
    fn write_default_config_if_missing_creates_file_when_absent() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.toml");
        assert!(!path.exists());
        let created = write_default_at(&path).unwrap();
        assert!(created);
        assert!(path.exists());
        let text = std::fs::read_to_string(&path).unwrap();
        assert!(text.contains("default_shell"));
    }

    #[test]
    fn write_default_config_if_missing_is_noop_when_present() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.toml");
        std::fs::write(&path, "existing = true").unwrap();
        let created = write_default_at(&path).unwrap();
        assert!(!created);
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "existing = true");
    }

    #[test]
    fn default_toml_has_cursor_and_typography_fields() {
        let cfg: LumeConfig = toml::from_str(DEFAULT_TOML).expect("parse default toml");
        assert_eq!(cfg.font.weight, 400);
        assert!((cfg.font.line_height - 1.2).abs() < f64::EPSILON);
        assert_eq!(cfg.terminal.cursor_style, "block");
        assert!(cfg.terminal.cursor_blink);
    }

    #[test]
    fn set_dotted_value_preserves_comments_and_other_tables() {
        let original = "# top comment\n[font]\nsize = 14\n\n[keybindings]\n# custom\nsplit_right = \"Ctrl+\\\\\"\n";
        let updated = apply_config_edit(original, "font.size", json!(18)).unwrap();
        assert!(updated.contains("# top comment"));
        assert!(updated.contains("[keybindings]"));
        assert!(updated.contains("split_right = \"Ctrl+\\\\\""));
        assert!(updated.contains("size = 18"));
    }

    #[test]
    fn set_dotted_value_creates_missing_table() {
        let updated = apply_config_edit("", "terminal.cursor_style", json!("bar")).unwrap();
        assert!(updated.contains("[terminal]"));
        assert!(updated.contains("cursor_style = \"bar\""));
    }

    #[test]
    fn set_dotted_value_rejects_unknown_root() {
        let err = apply_config_edit("", "bogus.key", json!(1));
        assert!(err.is_err());
    }

    #[test]
    fn set_dotted_value_writes_string_array() {
        // The collapsed_dirs chip list is the only array writer — exercise the
        // J::Array branch and confirm it round-trips back into a parseable doc.
        let updated = apply_config_edit(
            "",
            "sidebar.collapsed_dirs",
            json!(["node_modules", "dist"]),
        )
        .unwrap();
        assert!(updated.contains("[sidebar]"));
        assert!(updated.contains("collapsed_dirs"));
        assert!(updated.contains("\"node_modules\""));
        assert!(updated.contains("\"dist\""));
        // Re-parse to prove valid TOML with the array intact.
        let doc = updated.parse::<toml_edit::DocumentMut>().unwrap();
        let arr = doc["sidebar"]["collapsed_dirs"].as_array().unwrap();
        assert_eq!(arr.len(), 2);
    }

    #[test]
    fn set_dotted_value_rejects_non_string_array() {
        let err = apply_config_edit("", "sidebar.collapsed_dirs", json!([1, 2]));
        assert!(err.is_err());
    }
}

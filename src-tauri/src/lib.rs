// Lume Rust entry point.

pub mod agent_events;
pub mod attention;
pub mod claude_hooks;
pub mod config;
pub mod editor_watch;
pub mod error;
pub mod file_watcher;
pub mod fs;
pub mod git;
pub mod pty;
pub mod shell_detect;
pub mod shell_integration;

pub use error::{AppError, AppResult};

// `Manager` brings `App::state` into scope for the setup hook below.
use tauri::Manager;

/// Build the log plugin with safe defaults.
///
/// Why this is non-trivial: by default `tauri_plugin_log` will let every
/// dependency log at whatever level it chooses. `portable_pty::cmdbuilder`
/// emits a TRACE record for EACH environment variable it copies into the
/// spawned child — including secret-shaped values like `*_TOKEN`,
/// `*_API_KEY`, etc. Without a per-crate clamp those leak into stdout and
/// the on-disk log file.
///
/// Rules baked in here:
///   - Global default: DEBUG in dev builds, INFO in release.
///   - `portable_pty` and friends clamped to WARN — they're useful for
///     errors but they log env vars + arg vectors at TRACE/DEBUG.
///   - `tao` / `wry` / `webview2_com` similarly noisy; clamped.
///
/// If you ever flip `portable_pty` back to TRACE for debugging a real
/// spawn issue, scrub the resulting log file before pasting it anywhere.
fn build_log_plugin() -> tauri::plugin::TauriPlugin<tauri::Wry> {
    let default_level = if cfg!(debug_assertions) {
        log::LevelFilter::Debug
    } else {
        log::LevelFilter::Info
    };
    tauri_plugin_log::Builder::new()
        .level(default_level)
        // Clamp dependency crates that log env vars / args verbosely.
        .level_for("portable_pty", log::LevelFilter::Warn)
        .level_for("portable_pty::cmdbuilder", log::LevelFilter::Warn)
        .level_for("tao", log::LevelFilter::Warn)
        .level_for("wry", log::LevelFilter::Warn)
        .level_for("webview2_com", log::LevelFilter::Warn)
        .build()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(build_log_plugin())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .manage(pty::PtyRegistry::default())
        .manage(file_watcher::FileWatcherState::default())
        .manage(editor_watch::EditorWatchState::default())
        .manage(config::ConfigWatcherState::default())
        .manage(agent_events::AgentEventsState::default())
        .setup(|app| {
            // Agent-event pipeline (Plan 008): materialize the hook shim, clear
            // stale per-pane spool files from a prior run, and start watching
            // the spool dir. Each step is best-effort — a failure degrades to
            // today's cadence-only behavior and must never block launch.
            if let Err(e) = agent_events::materialize_hook_shim() {
                log::warn!("agent-events: hook shim not materialized: {e}");
            }
            if let Err(e) = agent_events::sweep_spool_dir() {
                log::warn!("agent-events: boot sweep failed: {e}");
            }
            match agent_events::start_watcher(app.handle().clone()) {
                Ok(watcher) => {
                    let state = app.state::<agent_events::AgentEventsState>();
                    *state.0.lock() = Some(watcher);
                }
                Err(e) => log::warn!("agent-events: watcher not started: {e}"),
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            pty::pty_open,
            pty::pty_write,
            pty::pty_resize,
            pty::pty_kill,
            pty::is_pty_busy,
            crate::fs::list_dir,
            crate::fs::read_text_file,
            crate::fs::read_editor_file,
            crate::fs::write_text_file,
            crate::fs::home_dir,
            crate::file_watcher::watch_workspace,
            crate::editor_watch::watch_editor_file,
            crate::editor_watch::unwatch_editor_file,
            crate::shell_detect::detect_shells,
            crate::config::read_config,
            crate::config::write_default_config_if_missing,
            crate::config::watch_config,
            crate::config::config_file_path,
            crate::config::set_config_value,
            crate::git::git_current_branch,
            crate::git::git_repo_root,
            crate::git::git_changed_files,
            crate::git::git_file_diff,
            crate::git::git_list_branches,
            crate::git::git_default_branch,
            crate::git::git_worktree_add,
            crate::git::git_worktree_list,
            crate::claude_hooks::claude_hooks_status,
            crate::claude_hooks::install_claude_hooks,
            crate::claude_hooks::uninstall_claude_hooks,
            crate::attention::set_needs_you_badge,
            crate::attention::flash_taskbar,
        ])
        .run(tauri::generate_context!())
        .expect("error while running lume");
}

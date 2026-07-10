// Claude Code hook install/uninstall (Plan 008 §5).
//
// The "Precise Claude Code signals" toggle merges Lume's agent-event shim into
// ~/.claude/settings.json — additively, preserving ALL existing content, and
// atomically (temp + rename, because it's a file we don't own; Plan 005's
// concern applies doubly). The command string (the absolute shim path, forward
// slashes) is the marker: uninstall removes exactly our entries and nothing
// else. A settings.json we can't PARSE aborts the write — we never clobber a
// file we couldn't read.
//
// The pure merge/unmerge/installed functions take the settings TEXT (not a
// path) so they're unit-testable against fixtures with zero risk of touching a
// real ~/.claude/settings.json. The command layer resolves the real path and
// does the atomic IO.

use std::path::{Path, PathBuf};

use serde_json::{json, Value};

use crate::error::{AppError, AppResult};

/// Events we hook. Non-tool events (all but Notification) need no matcher;
/// Notification uses an empty matcher (matches every notification).
///
/// SubagentStart/SubagentStop track BACKGROUND subagent lifecycle: the main
/// agent's `Stop` fires when ITS turn ends even while background subagents keep
/// running, so without these a session flips to "your move" while work is still
/// happening. A subagent hook with no matcher matches every subagent (matchers
/// would filter by agent type, which we don't want to). See sessions/
/// agentTracker.ts for how the count gates the sidebar signal back to "working".
const NON_TOOL_EVENTS: &[&str] = &[
    "SessionStart",
    "UserPromptSubmit",
    "Stop",
    "SessionEnd",
    "SubagentStart",
    "SubagentStop",
];
const NOTIFICATION_EVENT: &str = "Notification";

pub fn claude_settings_path() -> AppResult<PathBuf> {
    dirs::home_dir()
        .map(|p| p.join(".claude").join("settings.json"))
        .ok_or_else(|| AppError::internal("home dir unavailable"))
}

/// Normalize the shim path to forward slashes — MANDATORY: on Windows the hook
/// shell may be Git Bash, which eats backslashes in the command string.
pub fn hook_command(shim_path: &str) -> String {
    shim_path.replace('\\', "/")
}

/// The leaf hook object installed under each event.
fn hook_leaf(command: &str) -> Value {
    json!({
        "type": "command",
        "command": command,
        "async": true,
        "timeout": 10
    })
}

/// Parse settings text into a JSON object. Blank/whitespace-only is treated as
/// an empty object (a fresh install). Any other parse failure is an error — we
/// must NOT overwrite a file we couldn't read.
fn parse_settings(text: &str) -> AppResult<Value> {
    if text.trim().is_empty() {
        return Ok(json!({}));
    }
    let v: Value = serde_json::from_str(text)
        .map_err(|e| AppError::internal(format!("settings parse: {e}")))?;
    if !v.is_object() {
        return Err(AppError::internal("settings.json root is not an object"));
    }
    Ok(v)
}

/// Does `event_array` already contain a group whose hooks reference `command`?
fn event_has_command(event_array: &Value, command: &str) -> bool {
    event_array
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|g| g.get("hooks").and_then(|h| h.as_array()))
        .flatten()
        .any(|leaf| leaf.get("command").and_then(|c| c.as_str()) == Some(command))
}

/// True if Lume's hooks are present (checks the SessionStart array — the canary
/// event). Text that doesn't parse reads as "not installed".
pub fn hooks_installed(settings_text: &str, shim_path: &str) -> bool {
    let command = hook_command(shim_path);
    let Ok(v) = parse_settings(settings_text) else {
        return false;
    };
    v.get("hooks")
        .and_then(|h| h.get("SessionStart"))
        .map(|arr| event_has_command(arr, &command))
        .unwrap_or(false)
}

/// Additively merge Lume's hook entries. Existing entries are never touched —
/// we only APPEND a new matcher-group per event, and skip an event that already
/// carries our command (idempotent). Returns the new settings JSON text.
pub fn merge_hooks(settings_text: &str, shim_path: &str) -> AppResult<String> {
    let command = hook_command(shim_path);
    let mut root = parse_settings(settings_text)?;

    let obj = root
        .as_object_mut()
        .ok_or_else(|| AppError::internal("settings.json root is not an object"))?;
    let hooks = obj.entry("hooks").or_insert_with(|| json!({}));
    if !hooks.is_object() {
        return Err(AppError::internal("settings.json 'hooks' is not an object"));
    }
    let hooks = hooks.as_object_mut().unwrap();

    let add_group = |arr: &mut Vec<Value>, group: Value| arr.push(group);

    for event in NON_TOOL_EVENTS {
        let arr = hooks.entry(event.to_string()).or_insert_with(|| json!([]));
        if !arr.is_array() {
            return Err(AppError::internal(format!(
                "settings.json hooks.{event} is not an array"
            )));
        }
        if event_has_command(arr, &command) {
            continue;
        }
        add_group(
            arr.as_array_mut().unwrap(),
            json!({ "hooks": [hook_leaf(&command)] }),
        );
    }

    let notif = hooks
        .entry(NOTIFICATION_EVENT.to_string())
        .or_insert_with(|| json!([]));
    if !notif.is_array() {
        return Err(AppError::internal(
            "settings.json hooks.Notification is not an array",
        ));
    }
    if !event_has_command(notif, &command) {
        add_group(
            notif.as_array_mut().unwrap(),
            json!({ "matcher": "", "hooks": [hook_leaf(&command)] }),
        );
    }

    serde_json::to_string_pretty(&root)
        .map_err(|e| AppError::internal(format!("settings serialize: {e}")))
}

/// Remove exactly Lume's hook entries (command == our shim path). Groups left
/// with no hooks are pruned; events left with no groups and the `hooks` object
/// left empty are removed too — so uninstall round-trips back to the original
/// (modulo JSON formatting). Everything else is byte-preserved.
pub fn unmerge_hooks(settings_text: &str, shim_path: &str) -> AppResult<String> {
    let command = hook_command(shim_path);
    let mut root = parse_settings(settings_text)?;
    let obj = root.as_object_mut().unwrap(); // parse_settings guarantees object

    let hooks_empty = if let Some(hooks) = obj.get_mut("hooks").and_then(|h| h.as_object_mut()) {
        for event_arr in hooks.values_mut() {
            let Some(groups) = event_arr.as_array_mut() else {
                continue;
            };
            for group in groups.iter_mut() {
                if let Some(leaves) = group.get_mut("hooks").and_then(|h| h.as_array_mut()) {
                    leaves.retain(|leaf| {
                        leaf.get("command").and_then(|c| c.as_str()) != Some(&command)
                    });
                }
            }
            // Drop groups whose hooks array is now empty.
            groups.retain(|group| {
                group
                    .get("hooks")
                    .and_then(|h| h.as_array())
                    .map(|a| !a.is_empty())
                    .unwrap_or(true)
            });
        }
        // Drop events with no groups left.
        hooks.retain(|_, arr| arr.as_array().map(|a| !a.is_empty()).unwrap_or(true));
        hooks.is_empty()
    } else {
        false
    };
    if hooks_empty {
        obj.remove("hooks");
    }

    serde_json::to_string_pretty(&root)
        .map_err(|e| AppError::internal(format!("settings serialize: {e}")))
}

// ----- IO layer (path parameterized for testability) -----

fn atomic_write(path: &Path, contents: &str) -> AppResult<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| {
            AppError::internal(format!("create_dir_all {}: {}", parent.display(), e))
        })?;
    }
    // Temp + rename so a crash mid-write never leaves a truncated settings.json.
    let tmp = path.with_extension("json.lume-tmp");
    std::fs::write(&tmp, contents)
        .map_err(|e| AppError::internal(format!("write {}: {}", tmp.display(), e)))?;
    std::fs::rename(&tmp, path)
        .map_err(|e| AppError::internal(format!("rename into {}: {}", path.display(), e)))?;
    Ok(())
}

fn read_settings_text(path: &Path) -> AppResult<String> {
    match std::fs::read_to_string(path) {
        Ok(s) => Ok(s),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
        Err(e) => Err(AppError::internal(format!(
            "read {}: {}",
            path.display(),
            e
        ))),
    }
}

/// Install at an explicit settings path (tests pass a fixture path).
pub fn install_at(settings_path: &Path, shim_path: &str) -> AppResult<()> {
    let text = read_settings_text(settings_path)?;
    let merged = merge_hooks(&text, shim_path)?; // aborts here on unparseable JSON
    atomic_write(settings_path, &merged)
}

/// Uninstall at an explicit settings path (tests pass a fixture path).
pub fn uninstall_at(settings_path: &Path, shim_path: &str) -> AppResult<()> {
    let text = read_settings_text(settings_path)?;
    if text.trim().is_empty() {
        return Ok(()); // nothing to remove
    }
    let unmerged = unmerge_hooks(&text, shim_path)?;
    atomic_write(settings_path, &unmerged)
}

// ----- Tauri commands -----

#[tauri::command]
pub fn claude_hooks_status() -> AppResult<bool> {
    let path = claude_settings_path()?;
    let text = read_settings_text(&path)?;
    let shim = crate::agent_events::hook_shim_path()?;
    Ok(hooks_installed(&text, &shim.to_string_lossy()))
}

#[tauri::command]
pub fn install_claude_hooks() -> AppResult<()> {
    // Ensure the shim exists on disk before we point settings.json at it.
    let shim = crate::agent_events::materialize_hook_shim()?;
    let path = claude_settings_path()?;
    install_at(&path, &shim.to_string_lossy())
}

#[tauri::command]
pub fn uninstall_claude_hooks() -> AppResult<()> {
    let shim = crate::agent_events::hook_shim_path()?;
    let path = claude_settings_path()?;
    uninstall_at(&path, &shim.to_string_lossy())
}

// ----- Tests (fixtures only — never the real ~/.claude/settings.json) -----

#[cfg(test)]
mod tests {
    use super::*;

    const SHIM: &str = "C:\\Users\\me\\AppData\\Roaming\\lume\\lume-hook.cmd";
    // Forward-slash form the marker/command should take.
    const SHIM_FWD: &str = "C:/Users/me/AppData/Roaming/lume/lume-hook.cmd";

    #[test]
    fn hook_command_forces_forward_slashes() {
        assert_eq!(hook_command(SHIM), SHIM_FWD);
    }

    #[test]
    fn merge_into_empty_installs_all_events() {
        let out = merge_hooks("", SHIM).unwrap();
        assert!(hooks_installed(&out, SHIM));
        let v: Value = serde_json::from_str(&out).unwrap();
        let hooks = v.get("hooks").unwrap();
        for e in NON_TOOL_EVENTS {
            assert!(
                event_has_command(hooks.get(*e).unwrap(), SHIM_FWD),
                "missing {e}"
            );
            // Non-tool events carry NO matcher key.
            let group = &hooks.get(*e).unwrap()[0];
            assert!(group.get("matcher").is_none());
            assert_eq!(group["hooks"][0]["async"], json!(true));
            assert_eq!(group["hooks"][0]["timeout"], json!(10));
        }
        // The subagent lifecycle events are installed (background-turn tracking).
        assert!(event_has_command(
            hooks.get("SubagentStart").unwrap(),
            SHIM_FWD
        ));
        assert!(event_has_command(
            hooks.get("SubagentStop").unwrap(),
            SHIM_FWD
        ));
        // Notification uses an empty matcher.
        let notif = &hooks.get("Notification").unwrap()[0];
        assert_eq!(notif["matcher"], json!(""));
    }

    #[test]
    fn merge_preserves_foreign_hooks_and_top_level_keys() {
        let existing = r#"{
            "model": "claude-sonnet",
            "hooks": {
                "SessionStart": [
                    { "hooks": [ { "type": "command", "command": "/usr/bin/notify-me" } ] }
                ],
                "PreToolUse": [
                    { "matcher": "Bash", "hooks": [ { "type": "command", "command": "guard.sh" } ] }
                ]
            }
        }"#;
        let out = merge_hooks(existing, SHIM).unwrap();
        let v: Value = serde_json::from_str(&out).unwrap();
        // Foreign top-level key preserved.
        assert_eq!(v["model"], json!("claude-sonnet"));
        // Foreign SessionStart hook preserved alongside ours.
        let ss = v["hooks"]["SessionStart"].as_array().unwrap();
        assert!(ss
            .iter()
            .any(|g| g["hooks"][0]["command"] == json!("/usr/bin/notify-me")));
        assert!(event_has_command(&v["hooks"]["SessionStart"], SHIM_FWD));
        // Foreign PreToolUse (an event we don't manage) untouched.
        assert_eq!(v["hooks"]["PreToolUse"][0]["matcher"], json!("Bash"));
    }

    #[test]
    fn merge_is_idempotent() {
        let once = merge_hooks("", SHIM).unwrap();
        let twice = merge_hooks(&once, SHIM).unwrap();
        let v: Value = serde_json::from_str(&twice).unwrap();
        // Still exactly one of our groups under SessionStart.
        let ours = v["hooks"]["SessionStart"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|g| g["hooks"][0]["command"] == json!(SHIM_FWD))
            .count();
        assert_eq!(ours, 1);
    }

    #[test]
    fn unmerge_round_trips_back_to_original_shape() {
        let merged = merge_hooks("", SHIM).unwrap();
        assert!(hooks_installed(&merged, SHIM));
        let removed = unmerge_hooks(&merged, SHIM).unwrap();
        assert!(!hooks_installed(&removed, SHIM));
        // Fully clean: the whole empty hooks object is gone.
        let v: Value = serde_json::from_str(&removed).unwrap();
        assert!(v.get("hooks").is_none());
    }

    #[test]
    fn unmerge_leaves_foreign_hooks_intact() {
        let existing = r#"{
            "hooks": {
                "SessionStart": [
                    { "hooks": [ { "type": "command", "command": "/usr/bin/notify-me" } ] }
                ]
            }
        }"#;
        let merged = merge_hooks(existing, SHIM).unwrap();
        let removed = unmerge_hooks(&merged, SHIM).unwrap();
        let v: Value = serde_json::from_str(&removed).unwrap();
        // Ours gone…
        assert!(!hooks_installed(&removed, SHIM));
        // …the user's own SessionStart hook survives.
        let ss = v["hooks"]["SessionStart"].as_array().unwrap();
        assert_eq!(ss.len(), 1);
        assert_eq!(ss[0]["hooks"][0]["command"], json!("/usr/bin/notify-me"));
    }

    #[test]
    fn invalid_json_aborts_and_is_never_written() {
        // merge/unmerge both refuse to touch unparseable settings.
        assert!(merge_hooks("{ not valid json ", SHIM).is_err());
        assert!(unmerge_hooks("}}}", SHIM).is_err());
    }

    #[test]
    fn install_uninstall_round_trip_on_disk() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(".claude").join("settings.json");
        // Seed a file with a foreign key to prove preservation through IO.
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, r#"{"model":"x"}"#).unwrap();

        install_at(&path, SHIM).unwrap();
        let after_install = std::fs::read_to_string(&path).unwrap();
        assert!(hooks_installed(&after_install, SHIM));
        assert!(after_install.contains("\"model\""));

        uninstall_at(&path, SHIM).unwrap();
        let after_uninstall = std::fs::read_to_string(&path).unwrap();
        assert!(!hooks_installed(&after_uninstall, SHIM));
        assert!(after_uninstall.contains("\"model\""));
    }

    #[test]
    fn install_aborts_on_unparseable_file_without_writing() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("settings.json");
        std::fs::write(&path, "{ broken").unwrap();
        assert!(install_at(&path, SHIM).is_err());
        // File left exactly as it was — never overwritten.
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "{ broken");
    }
}

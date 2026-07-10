// Editor-tab external-change watcher (Plan 010 Phase A §3).
//
// THE agent-safety feature: when an open editor tab's file changes on disk
// (an agent rewrites it, a formatter runs, git checkout swaps it), Lume must
// notice so the frontend can silently reload a clean tab or raise a conflict
// bar on a dirty one. Without this, an agent's edits to a file you also have
// open would be silently clobbered by the next in-app Save.
//
// Architecture: ONE `notify` watcher instance, shared across all open tabs.
// notify (ReadDirectoryChangesW on Windows) reports per-directory, so rather
// than watch each file we watch each file's PARENT directory non-recursively
// and reference-count the dirs (WatchSet below). The event handler emits a
// Tauri `file-changed { path }` only for paths in the tracked FILE set, so
// sibling-file churn in a shared dir is filtered out. Tabs add/remove their
// path via the watch_editor_file / unwatch_editor_file commands.
//
// Self-write suppression lives on the FRONTEND (mdStore): after an in-app
// Save the store ignores the echo event for a short window and also
// content-compares disk vs buffer. This module stays a dumb pipe — it reports
// every change; the store decides what is "external".
//
// notify itself spawns no subprocess, so there is no Windows console to
// suppress here. Any future shell-out from this module MUST set
// CREATE_NO_WINDOW (see pty.rs) to avoid the console-flash freeze.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use notify::{Config, Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use parking_lot::Mutex;
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

use crate::error::{AppError, AppResult};

#[derive(Debug, Clone, Serialize)]
pub struct FileChanged {
    pub path: String,
}

/// Normalize a path for set membership: forward slashes + lowercase so a
/// watched `C:\Proj\a.rs` matches an event path notify reports as
/// `C:\proj\a.rs`. Windows-first app; the case-fold is harmless there and the
/// separator-fold is what actually matters cross-platform in tests.
fn norm(p: &Path) -> String {
    p.to_string_lossy().replace('\\', "/").to_lowercase()
}

/// Tracks which FILE paths are open and, derived from them, which parent DIRS
/// the watcher must subscribe to (reference-counted so closing one tab doesn't
/// unwatch a dir another open tab still needs). Pure + unit-tested; the notify
/// watcher is a thin shell around it.
#[derive(Default)]
pub struct WatchSet {
    /// Normalized file paths we emit events for.
    files: HashSet<String>,
    /// Normalized parent dir -> (original path, refcount).
    dirs: HashMap<String, (PathBuf, usize)>,
}

impl WatchSet {
    /// Register a file. Returns Some(dir) when its parent dir is newly tracked
    /// and the caller must start watching it; None when already watched.
    pub fn add(&mut self, path: &Path) -> Option<PathBuf> {
        self.files.insert(norm(path));
        let dir = path.parent()?.to_path_buf();
        let key = norm(&dir);
        let entry = self.dirs.entry(key).or_insert((dir.clone(), 0));
        entry.1 += 1;
        if entry.1 == 1 {
            Some(dir)
        } else {
            None
        }
    }

    /// Unregister a file. Returns Some(dir) when its parent dir dropped to zero
    /// refs and the caller must stop watching it; None otherwise.
    pub fn remove(&mut self, path: &Path) -> Option<PathBuf> {
        self.files.remove(&norm(path));
        let dir = path.parent()?;
        let key = norm(dir);
        if let Some(entry) = self.dirs.get_mut(&key) {
            entry.1 -= 1;
            if entry.1 == 0 {
                let original = entry.0.clone();
                self.dirs.remove(&key);
                return Some(original);
            }
        }
        None
    }

    /// Whether an event path corresponds to a tracked open file.
    pub fn matches(&self, path: &Path) -> bool {
        self.files.contains(&norm(path))
    }
}

/// Managed Tauri state: the live watcher plus the shared WatchSet the event
/// handler consults. The WatchSet is behind an Arc so the handler closure and
/// the commands share one instance.
#[derive(Default)]
pub struct EditorWatchState {
    pub watcher: Mutex<Option<RecommendedWatcher>>,
    pub set: Arc<Mutex<WatchSet>>,
}

fn build_watcher(app: AppHandle, set: Arc<Mutex<WatchSet>>) -> AppResult<RecommendedWatcher> {
    let mut watcher = notify::recommended_watcher(move |res: notify::Result<Event>| {
        let Ok(event) = res else { return };
        // Content-writes surface as Modify; a replace-on-save (write temp +
        // rename) surfaces as Create/Remove on the target name. Treat all three
        // as "the file might have changed" and let the frontend compare.
        if !matches!(
            event.kind,
            EventKind::Modify(_) | EventKind::Create(_) | EventKind::Remove(_)
        ) {
            return;
        }
        let guard = set.lock();
        for p in &event.paths {
            if guard.matches(p) {
                let _ = app.emit(
                    "file-changed",
                    FileChanged {
                        path: p.to_string_lossy().to_string(),
                    },
                );
            }
        }
    })
    .map_err(|e| AppError::internal(format!("editor watcher create: {e}")))?;
    watcher
        .configure(Config::default().with_compare_contents(false))
        .map_err(|e| AppError::internal(format!("editor watcher config: {e}")))?;
    Ok(watcher)
}

/// Begin watching an open tab's file. Lazily creates the shared watcher on the
/// first call, then subscribes the file's parent dir (once per dir).
#[tauri::command]
pub fn watch_editor_file(
    app: AppHandle,
    state: State<'_, EditorWatchState>,
    path: String,
) -> AppResult<()> {
    let pb = PathBuf::from(&path);
    let mut watcher_slot = state.watcher.lock();
    if watcher_slot.is_none() {
        *watcher_slot = Some(build_watcher(app.clone(), state.set.clone())?);
    }
    let new_dir = state.set.lock().add(&pb);
    if let (Some(dir), Some(watcher)) = (new_dir, watcher_slot.as_mut()) {
        watcher
            .watch(&dir, RecursiveMode::NonRecursive)
            .map_err(|e| AppError::internal(format!("watch {}: {}", dir.display(), e)))?;
    }
    Ok(())
}

/// Stop watching an open tab's file. Unsubscribes the parent dir only when no
/// other open tab still lives there.
#[tauri::command]
pub fn unwatch_editor_file(state: State<'_, EditorWatchState>, path: String) -> AppResult<()> {
    let pb = PathBuf::from(&path);
    let drop_dir = state.set.lock().remove(&pb);
    if let Some(dir) = drop_dir {
        if let Some(watcher) = state.watcher.lock().as_mut() {
            // Ignore unwatch errors: the dir may already be gone (deleted) or
            // never successfully watched. Nothing actionable either way.
            let _ = watcher.unwatch(&dir);
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn add_first_file_in_dir_returns_dir_to_watch() {
        let mut ws = WatchSet::default();
        let watch = ws.add(Path::new("/proj/a.rs"));
        assert_eq!(watch, Some(PathBuf::from("/proj")));
        assert!(ws.matches(Path::new("/proj/a.rs")));
    }

    #[test]
    fn second_file_same_dir_does_not_rewatch() {
        let mut ws = WatchSet::default();
        assert!(ws.add(Path::new("/proj/a.rs")).is_some());
        // Same dir → no new watch needed.
        assert!(ws.add(Path::new("/proj/b.rs")).is_none());
        assert!(ws.matches(Path::new("/proj/b.rs")));
    }

    #[test]
    fn remove_last_file_in_dir_returns_dir_to_unwatch() {
        let mut ws = WatchSet::default();
        ws.add(Path::new("/proj/a.rs"));
        ws.add(Path::new("/proj/b.rs"));
        // First removal keeps the dir (b.rs still there).
        assert!(ws.remove(Path::new("/proj/a.rs")).is_none());
        assert!(!ws.matches(Path::new("/proj/a.rs")));
        // Last removal releases the dir.
        assert_eq!(
            ws.remove(Path::new("/proj/b.rs")),
            Some(PathBuf::from("/proj"))
        );
        assert!(!ws.matches(Path::new("/proj/b.rs")));
    }

    #[test]
    fn matching_is_separator_and_case_insensitive() {
        let mut ws = WatchSet::default();
        ws.add(Path::new(r"C:\Proj\File.rs"));
        // notify may report a differently-cased / forward-slashed path.
        assert!(ws.matches(Path::new("C:/proj/file.rs")));
        assert!(!ws.matches(Path::new("C:/proj/other.rs")));
    }

    #[test]
    fn remove_unknown_file_is_noop() {
        let mut ws = WatchSet::default();
        assert!(ws.remove(Path::new("/never/added.rs")).is_none());
    }
}

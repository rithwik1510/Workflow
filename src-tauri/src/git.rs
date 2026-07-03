//! Git observation commands (Plan 010 Phase B — the Diff tab) plus the
//! long-standing `git_current_branch` used by the branch poller.
//!
//! PRODUCT BOUNDARY: everything here is READ-ONLY observation of git. We never
//! stage, commit, or mutate a repo — the frontend only ever lists changed files
//! and reads old/new file contents to render a diff.
//!
//! CRITICAL (Windows): every spawned `git` MUST set CREATE_NO_WINDOW. Without
//! it Windows pops a console window for each spawn; the pollers here fire every
//! few seconds, so a missed flag produced the visible console-flash + UI-freeze
//! bug that already shipped once (see lume-windows-subprocess-flicker). All
//! spawns go through `run_git`, which sets the flag in one place.
//!
//! Timeouts: std::process has no native timeout — `Command::output()` blocks
//! until the child exits, so a hung `git` on a dead UNC/network path would wedge
//! the async command worker forever. `run_git` runs the child on a throwaway
//! thread and waits on an mpsc with a deadline; a timed-out call returns None
//! (the receiver drops, the orphaned thread's send just fails silently).

#[cfg(windows)]
use std::os::windows::process::CommandExt;
use std::path::Path;
use std::process::{Command, Output, Stdio};
use std::sync::mpsc;
use std::thread;
use std::time::Duration;

use serde::Serialize;

use crate::error::{AppError, AppResult};
use crate::fs::EDITOR_SIZE_CAP;

/// Branch lookup is tiny; keep it snappy so a bad path fails fast.
const BRANCH_TIMEOUT: Duration = Duration::from_secs(2);
/// status / show can touch the whole tree on a big repo; give them headroom.
const DIFF_TIMEOUT: Duration = Duration::from_secs(10);

/// CREATE_NO_WINDOW — suppress the console window Windows would otherwise flash
/// for every `git` spawn. See the module header; this is non-negotiable.
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Bytes sniffed for a NUL to classify content as binary — mirrors fs.rs. A NUL
/// is valid UTF-8 (U+0000), so a plain `from_utf8` check would pass a binary
/// blob; we must sniff the raw bytes.
const BINARY_SNIFF_BYTES: usize = 8192;

fn looks_binary(bytes: &[u8]) -> bool {
    let head = &bytes[..bytes.len().min(BINARY_SNIFF_BYTES)];
    head.contains(&0)
}

/// Spawn `git <args>` in `dir`, capturing stdout, with a hard timeout and the
/// Windows console-suppression flag. Returns None on spawn failure or timeout.
/// stderr is discarded — callers treat any failure as "no data" (not a repo,
/// path missing, detached HEAD, object absent, …), never a user-facing error.
fn run_git(dir: &str, args: &[&str], timeout: Duration) -> Option<Output> {
    let dir = dir.to_string();
    let args: Vec<String> = args.iter().map(|s| s.to_string()).collect();
    let (tx, rx) = mpsc::channel();
    thread::spawn(move || {
        let mut cmd = Command::new("git");
        cmd.args(&args)
            .current_dir(&dir)
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        #[cfg(windows)]
        cmd.creation_flags(CREATE_NO_WINDOW);
        // Receiver may already be gone (we timed out) — ignore the send error.
        let _ = tx.send(cmd.output());
    });
    rx.recv_timeout(timeout).ok()?.ok()
}

/// `git rev-parse --abbrev-ref HEAD` — current branch name, or None (not a repo,
/// detached HEAD, missing git, timeout). Unchanged behaviour from Plan 006.
#[tauri::command]
pub fn git_current_branch(path: String) -> Option<String> {
    let output = run_git(
        &path,
        &["rev-parse", "--abbrev-ref", "HEAD"],
        BRANCH_TIMEOUT,
    )?;
    if !output.status.success() {
        return None;
    }
    let branch = String::from_utf8(output.stdout).ok()?.trim().to_string();
    if branch.is_empty() || branch == "HEAD" {
        // Empty = error. "HEAD" = detached. Treat both as no branch.
        return None;
    }
    Some(branch)
}

/// `git rev-parse --show-toplevel` — the repository root that CONTAINS `path`,
/// or None if `path` isn't inside a git repo. Used to fold a session's per-pane
/// cwds down to the distinct set of repos to offer in the Diff tab. `git`
/// already emits forward-slash paths here (even on Windows), so the result is a
/// stable, canonical key for de-duping repos across panes.
#[tauri::command]
pub fn git_repo_root(path: String) -> Option<String> {
    let output = run_git(&path, &["rev-parse", "--show-toplevel"], BRANCH_TIMEOUT)?;
    if !output.status.success() {
        return None;
    }
    let root = String::from_utf8(output.stdout).ok()?.trim().to_string();
    if root.is_empty() {
        return None;
    }
    Some(root)
}

/// One changed file in the working tree, relative to HEAD. `status` is a
/// normalised kind (not the raw XY letters) so the UI maps it straight to a
/// glyph. `old_path` is set only for renames/copies (the pre-rename path), so
/// the diff can read the old content from HEAD at the original path.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChangedFile {
    /// "modified" | "added" | "deleted" | "renamed" | "untracked"
    pub status: String,
    /// Repo-relative path (forward slashes, from git's -z output).
    pub path: String,
    /// Pre-rename path for renamed/copied entries; None otherwise.
    pub old_path: Option<String>,
}

/// Parse `git status --porcelain=v1 -z` output into changed files.
///
/// The -z format is a flat stream of NUL-terminated records. A normal record is
/// `XY<space>PATH`; a rename/copy record is `XY<space>NEWPATH` immediately
/// followed by a *separate* NUL-terminated `ORIGPATH` field (no XY prefix). We
/// therefore can't just split-and-map — a rename consumes the following field.
///
/// XY are the index (X) and worktree (Y) status. We collapse them to one kind by
/// priority R > D > A > M so the common single-sided cases (a plain modify shows
/// ` M`, a staged add shows `A `, etc.) land on the right glyph. `??` is
/// untracked (rendered as a whole-file addition by the diff).
fn parse_status_porcelain_z(data: &str) -> Vec<ChangedFile> {
    let mut out = Vec::new();
    let mut fields = data.split('\0');
    while let Some(entry) = fields.next() {
        // Trailing empty field after the final NUL, or any stray blank.
        if entry.len() < 3 {
            continue;
        }
        let bytes = entry.as_bytes();
        let x = bytes[0] as char;
        let y = bytes[1] as char;
        // bytes[2] is the separating space; the path is everything after it.
        let path = entry[3..].to_string();

        if x == '?' && y == '?' {
            out.push(ChangedFile {
                status: "untracked".to_string(),
                path,
                old_path: None,
            });
            continue;
        }

        let is_rename = x == 'R' || y == 'R';
        let is_copy = x == 'C' || y == 'C';
        // A rename/copy record is followed by its origin path as the next field.
        let old_path = if is_rename || is_copy {
            fields.next().map(str::to_string)
        } else {
            None
        };

        let status = if is_rename {
            "renamed"
        } else if is_copy {
            "added"
        } else if x == 'D' || y == 'D' {
            "deleted"
        } else if x == 'A' || y == 'A' {
            "added"
        } else {
            "modified"
        };

        out.push(ChangedFile {
            status: status.to_string(),
            path,
            old_path,
        });
    }
    out
}

/// List the working-tree changes vs HEAD for a repo. Always uses HEAD as the
/// base (see Plan 010 §3 — the merge-base option was scoped out to keep the
/// changed-file list and the per-file diff on the same coherent base). Errors
/// (missing git, deleted repo) surface as an AppError the store turns into an
/// empty-state, not a toast.
#[tauri::command]
pub fn git_changed_files(repo: String) -> AppResult<Vec<ChangedFile>> {
    let output =
        run_git(&repo, &["status", "--porcelain=v1", "-z"], DIFF_TIMEOUT).ok_or_else(|| {
            AppError::Internal {
                reason: format!("git status failed or timed out in {repo}"),
            }
        })?;
    if !output.status.success() {
        return Err(AppError::Internal {
            reason: format!("git status exited non-zero in {repo}"),
        });
    }
    // -z paths are raw bytes; lossy-decode so an odd non-UTF8 name still lists.
    let text = String::from_utf8_lossy(&output.stdout);
    Ok(parse_status_porcelain_z(&text))
}

/// Old + new contents for one changed file, ready to hand to @codemirror/merge
/// (which diffs the two texts itself — we don't parse git's patch output).
///
///   - modified: old = HEAD:path,     new = working file
///   - added / untracked: old = "",   new = working file
///   - deleted: old = HEAD:path,      new = ""
///   - renamed: old = HEAD:old_path,  new = working file at path
///
/// `binary` (NUL sniff on either side) and `too_large` (either side over the
/// editor cap) short-circuit rendering — the UI shows a placeholder instead of
/// a diff, matching the editor's own guards.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileDiff {
    pub old_text: String,
    pub new_text: String,
    pub binary: bool,
    pub too_large: bool,
}

#[tauri::command]
pub fn git_file_diff(repo: String, path: String, old_path: Option<String>) -> AppResult<FileDiff> {
    // Old side: the blob at HEAD. For a rename that's the pre-rename path. A
    // git failure here means "not in HEAD" (added/untracked) → empty old side.
    let old_rel = old_path.as_deref().unwrap_or(&path);
    let old_bytes = run_git(&repo, &["show", &format!("HEAD:{old_rel}")], DIFF_TIMEOUT)
        .filter(|o| o.status.success())
        .map(|o| o.stdout)
        .unwrap_or_default();

    // New side: the working-tree file. Missing = deleted → empty new side.
    let work_path = Path::new(&repo).join(&path);
    let new_bytes = std::fs::read(&work_path).unwrap_or_default();

    if looks_binary(&old_bytes) || looks_binary(&new_bytes) {
        return Ok(FileDiff {
            old_text: String::new(),
            new_text: String::new(),
            binary: true,
            too_large: false,
        });
    }
    if old_bytes.len() as u64 > EDITOR_SIZE_CAP || new_bytes.len() as u64 > EDITOR_SIZE_CAP {
        return Ok(FileDiff {
            old_text: String::new(),
            new_text: String::new(),
            binary: false,
            too_large: true,
        });
    }

    Ok(FileDiff {
        old_text: String::from_utf8_lossy(&old_bytes).to_string(),
        new_text: String::from_utf8_lossy(&new_bytes).to_string(),
        binary: false,
        too_large: false,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command as StdCommand;

    // ---- pure parser tests (no git needed) ----

    #[test]
    fn parses_modified_added_deleted_untracked() {
        // ` M`, `A `, ` D`, `??` — one field each, NUL-terminated.
        let data = " M src/a.rs\0A  src/b.rs\0 D src/c.rs\0?? src/d.rs\0";
        let files = parse_status_porcelain_z(data);
        assert_eq!(files.len(), 4);
        assert_eq!(files[0].status, "modified");
        assert_eq!(files[0].path, "src/a.rs");
        assert_eq!(files[1].status, "added");
        assert_eq!(files[1].path, "src/b.rs");
        assert_eq!(files[2].status, "deleted");
        assert_eq!(files[2].path, "src/c.rs");
        assert_eq!(files[3].status, "untracked");
        assert_eq!(files[3].path, "src/d.rs");
        assert!(files.iter().all(|f| f.old_path.is_none()));
    }

    #[test]
    fn parses_rename_with_two_path_form() {
        // Rename record: `R  NEW` then a separate ORIG field. The parser must
        // consume the origin field, not treat it as its own entry.
        let data = "R  new.rs\0old.rs\0 M other.rs\0";
        let files = parse_status_porcelain_z(data);
        assert_eq!(files.len(), 2, "origin field must not become an entry");
        assert_eq!(files[0].status, "renamed");
        assert_eq!(files[0].path, "new.rs");
        assert_eq!(files[0].old_path.as_deref(), Some("old.rs"));
        assert_eq!(files[1].status, "modified");
        assert_eq!(files[1].path, "other.rs");
    }

    #[test]
    fn empty_status_is_no_files() {
        assert!(parse_status_porcelain_z("").is_empty());
        assert!(parse_status_porcelain_z("\0").is_empty());
    }

    // ---- fixture-repo integration tests ----
    //
    // These build a throwaway repo in a temp dir. They are skipped (not failed)
    // when `git` isn't on PATH so the suite still runs in a bare CI image. They
    // NEVER touch the Lume repo — every mutation is inside the tempdir.

    fn git_available() -> bool {
        StdCommand::new("git")
            .arg("--version")
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .map(|s| s.success())
            .unwrap_or(false)
    }

    fn git_in(dir: &Path, args: &[&str]) {
        let ok = StdCommand::new("git")
            .args(args)
            .current_dir(dir)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .expect("spawn git")
            .success();
        assert!(ok, "git {args:?} failed");
    }

    fn init_repo(dir: &Path) {
        git_in(dir, &["init", "-q"]);
        git_in(dir, &["config", "user.email", "t@t.t"]);
        git_in(dir, &["config", "user.name", "t"]);
        git_in(dir, &["config", "commit.gpgsign", "false"]);
    }

    #[test]
    fn repo_root_resolves_subdir_to_toplevel() {
        if !git_available() {
            return;
        }
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        init_repo(root);
        let sub = root.join("nested");
        std::fs::create_dir(&sub).unwrap();
        let got = git_repo_root(sub.to_string_lossy().to_string());
        assert!(got.is_some(), "subdir should resolve to a repo root");
        // git emits forward slashes; compare on the trailing component to dodge
        // symlink/`/private` canonicalisation differences across platforms.
        assert!(got
            .unwrap()
            .replace('\\', "/")
            .ends_with(root.file_name().unwrap().to_string_lossy().as_ref()));
    }

    #[test]
    fn repo_root_none_outside_repo() {
        if !git_available() {
            return;
        }
        let dir = tempfile::tempdir().unwrap(); // no git init
        assert_eq!(
            git_repo_root(dir.path().to_string_lossy().to_string()),
            None
        );
    }

    #[test]
    fn changed_files_reports_modify_add_delete_untracked() {
        if !git_available() {
            return;
        }
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        init_repo(root);
        std::fs::write(root.join("keep.txt"), "one\n").unwrap();
        std::fs::write(root.join("gone.txt"), "bye\n").unwrap();
        git_in(root, &["add", "."]);
        git_in(root, &["commit", "-q", "-m", "init"]);

        std::fs::write(root.join("keep.txt"), "one\ntwo\n").unwrap(); // modify
        std::fs::remove_file(root.join("gone.txt")).unwrap(); // delete
        std::fs::write(root.join("fresh.txt"), "new\n").unwrap(); // untracked

        let files = git_changed_files(root.to_string_lossy().to_string()).unwrap();
        let by = |p: &str| files.iter().find(|f| f.path == p).cloned();
        assert_eq!(by("keep.txt").unwrap().status, "modified");
        assert_eq!(by("gone.txt").unwrap().status, "deleted");
        assert_eq!(by("fresh.txt").unwrap().status, "untracked");
    }

    #[test]
    fn changed_files_reports_rename_with_old_path() {
        if !git_available() {
            return;
        }
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        init_repo(root);
        std::fs::write(root.join("before.txt"), "stable content here\n").unwrap();
        git_in(root, &["add", "."]);
        git_in(root, &["commit", "-q", "-m", "init"]);
        git_in(root, &["mv", "before.txt", "after.txt"]);

        let files = git_changed_files(root.to_string_lossy().to_string()).unwrap();
        let renamed = files
            .iter()
            .find(|f| f.status == "renamed")
            .expect("a renamed entry");
        assert_eq!(renamed.path, "after.txt");
        assert_eq!(renamed.old_path.as_deref(), Some("before.txt"));
    }

    #[test]
    fn file_diff_modified_returns_both_sides() {
        if !git_available() {
            return;
        }
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        init_repo(root);
        std::fs::write(root.join("a.txt"), "old line\n").unwrap();
        git_in(root, &["add", "."]);
        git_in(root, &["commit", "-q", "-m", "init"]);
        std::fs::write(root.join("a.txt"), "new line\n").unwrap();

        let d = git_file_diff(
            root.to_string_lossy().to_string(),
            "a.txt".to_string(),
            None,
        )
        .unwrap();
        assert_eq!(d.old_text, "old line\n");
        assert_eq!(d.new_text, "new line\n");
        assert!(!d.binary && !d.too_large);
    }

    #[test]
    fn file_diff_untracked_is_whole_file_addition() {
        if !git_available() {
            return;
        }
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        init_repo(root);
        std::fs::write(root.join("seed.txt"), "seed\n").unwrap();
        git_in(root, &["add", "."]);
        git_in(root, &["commit", "-q", "-m", "init"]);
        std::fs::write(root.join("brand.txt"), "fresh\n").unwrap();

        let d = git_file_diff(
            root.to_string_lossy().to_string(),
            "brand.txt".to_string(),
            None,
        )
        .unwrap();
        assert_eq!(d.old_text, ""); // not in HEAD → empty old side
        assert_eq!(d.new_text, "fresh\n");
    }

    #[test]
    fn file_diff_deleted_has_empty_new_side() {
        if !git_available() {
            return;
        }
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        init_repo(root);
        std::fs::write(root.join("doomed.txt"), "here\n").unwrap();
        git_in(root, &["add", "."]);
        git_in(root, &["commit", "-q", "-m", "init"]);
        std::fs::remove_file(root.join("doomed.txt")).unwrap();

        let d = git_file_diff(
            root.to_string_lossy().to_string(),
            "doomed.txt".to_string(),
            None,
        )
        .unwrap();
        assert_eq!(d.old_text, "here\n");
        assert_eq!(d.new_text, ""); // gone from the working tree
    }

    #[test]
    fn file_diff_binary_is_flagged_not_rendered() {
        if !git_available() {
            return;
        }
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        init_repo(root);
        git_in(root, &["commit", "-q", "--allow-empty", "-m", "init"]);
        std::fs::write(root.join("blob.bin"), b"MZ\x00\x00\x00payload").unwrap();

        let d = git_file_diff(
            root.to_string_lossy().to_string(),
            "blob.bin".to_string(),
            None,
        )
        .unwrap();
        assert!(d.binary);
        assert_eq!(d.new_text, "");
    }
}

// File-system commands for the Sidebar + MD editor.
//
// SECURITY NOTE: these commands operate with the user's privilege, so
// callers can already do anything the user can. We do NOT sandbox to a
// "workspace root" here — the user explicitly opens files via the
// Sidebar / MD picker, and the spec puts Workspace Folder selection on
// the user (DESIGN.md §3 Workspace Folder). Validation we DO apply:
//   - canonicalise the path so symlink-traversal returns the real path
//   - return a typed AppError on permission / not-found / IO failure

use serde::Serialize;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};

use crate::error::{AppError, AppResult};

/// Files above this size open READ-ONLY with a banner (Plan 010 §2). CodeMirror
/// stays responsive well past this, but 1.5 MB is the line past which a text
/// file is almost certainly generated/data, not something you hand-edit.
pub const EDITOR_SIZE_CAP: u64 = 1_572_864; // 1.5 * 1024 * 1024

/// Files above THIS size are refused outright (`refused`, toast) — never read.
/// The read-only band (1.5–10 MB) still loads into CodeMirror; past 10 MB even
/// a read-only buffer would ship tens of MB across IPC into the webview and
/// freeze it. Nothing hand-reviewable lives above 10 MB of text.
pub const EDITOR_REFUSE_CAP: u64 = 10 * 1024 * 1024;

/// Bytes sniffed for a NUL to classify a file as binary. A NUL is valid UTF-8
/// (U+0000), so `read_to_string` would happily load a binary blob — we must
/// sniff the raw bytes ourselves.
const BINARY_SNIFF_BYTES: usize = 8192;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct DirEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    /// File size in bytes (0 for dirs).
    pub size: u64,
    /// Last modified epoch ms (None if filesystem doesn't expose it).
    pub modified_ms: Option<i64>,
}

/// Strip Windows' `\\?\` verbatim prefix that `fs::canonicalize` adds, so the
/// paths we hand the UI match the *non-verbatim* paths the file watcher emits
/// (`file_watcher.rs`) and the shell's cwd. Without this the Sidebar tree is
/// keyed `\\?\C:\…\docs` while watcher-driven refreshes key plain `C:\…\docs`,
/// so a file the agent just created updates a phantom key and never appears in
/// the tree. No-op on paths without the prefix (and on non-Windows).
fn strip_verbatim(p: &Path) -> String {
    let s = p.to_string_lossy();
    if let Some(rest) = s.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{rest}")
    } else if let Some(rest) = s.strip_prefix(r"\\?\") {
        rest.to_string()
    } else {
        s.into_owned()
    }
}

fn to_entry(entry: &fs::DirEntry) -> AppResult<DirEntry> {
    let meta = entry.metadata().map_err(|e| AppError::Internal {
        reason: format!("metadata {}: {}", entry.path().display(), e),
    })?;
    let modified_ms = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .and_then(|d| i64::try_from(d.as_millis()).ok());
    Ok(DirEntry {
        name: entry.file_name().to_string_lossy().to_string(),
        path: strip_verbatim(&entry.path()),
        is_dir: meta.is_dir(),
        size: if meta.is_dir() { 0 } else { meta.len() },
        modified_ms,
    })
}

#[tauri::command]
pub fn list_dir(path: String) -> AppResult<Vec<DirEntry>> {
    let p = PathBuf::from(&path);
    let canonical = p.canonicalize().map_err(|e| AppError::Internal {
        reason: format!("canonicalize {}: {}", path, e),
    })?;
    let read = fs::read_dir(&canonical).map_err(|e| AppError::Internal {
        reason: format!("read_dir {}: {}", canonical.display(), e),
    })?;
    let mut out = Vec::new();
    for entry in read.flatten() {
        if let Ok(e) = to_entry(&entry) {
            out.push(e);
        }
    }
    // Folders first, then alphabetical within each group. Matches VSCode / Finder default.
    out.sort_by(|a, b| match (a.is_dir, b.is_dir) {
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
    });
    Ok(out)
}

#[tauri::command]
pub fn read_text_file(path: String) -> AppResult<String> {
    fs::read_to_string(&path).map_err(|e| AppError::Internal {
        reason: format!("read {}: {}", path, e),
    })
}

#[tauri::command]
pub fn write_text_file(path: String, contents: String) -> AppResult<()> {
    if let Some(parent) = Path::new(&path).parent() {
        if !parent.exists() {
            fs::create_dir_all(parent).map_err(|e| AppError::Internal {
                reason: format!("create_dir_all {}: {}", parent.display(), e),
            })?;
        }
    }
    fs::write(&path, contents).map_err(|e| AppError::Internal {
        reason: format!("write {}: {}", path, e),
    })
}

/// Probe + read a file for the Editor (Plan 010 §2). Unlike `read_text_file`,
/// this reports the size and a binary/too-large classification so the frontend
/// can refuse binaries (toast) and open oversized files read-only (banner).
///
/// Order matters: sniff the first 8 KB for a NUL BEFORE reading the whole
/// file, so a multi-GB binary is rejected without loading it into memory.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EditorFile {
    pub content: String,
    pub size: u64,
    pub too_large: bool,
    pub binary: bool,
    /// Over EDITOR_REFUSE_CAP — content was never read; frontend toasts.
    pub refused: bool,
}

#[tauri::command]
pub fn read_editor_file(path: String) -> AppResult<EditorFile> {
    let meta = fs::metadata(&path).map_err(|e| AppError::Internal {
        reason: format!("metadata {}: {}", path, e),
    })?;
    let size = meta.len();
    let too_large = size > EDITOR_SIZE_CAP;
    if size > EDITOR_REFUSE_CAP {
        // Refuse before opening: don't pay for a read we'll never render.
        return Ok(EditorFile {
            content: String::new(),
            size,
            too_large,
            binary: false,
            refused: true,
        });
    }

    let mut file = fs::File::open(&path).map_err(|e| AppError::Internal {
        reason: format!("open {}: {}", path, e),
    })?;
    let mut head = vec![0u8; BINARY_SNIFF_BYTES];
    let n = file.read(&mut head).map_err(|e| AppError::Internal {
        reason: format!("read {}: {}", path, e),
    })?;
    if head[..n].contains(&0) {
        // Binary — bail before reading the rest. Frontend shows a toast.
        return Ok(EditorFile {
            content: String::new(),
            size,
            too_large,
            binary: true,
            refused: false,
        });
    }

    // Text: reuse the already-read head, then append the remainder so we don't
    // read those first bytes twice.
    let mut rest = Vec::new();
    file.read_to_end(&mut rest)
        .map_err(|e| AppError::Internal {
            reason: format!("read {}: {}", path, e),
        })?;
    let mut bytes = head[..n].to_vec();
    bytes.extend_from_slice(&rest);
    let content = String::from_utf8_lossy(&bytes).to_string();
    Ok(EditorFile {
        content,
        size,
        too_large,
        binary: false,
        refused: false,
    })
}

#[tauri::command]
pub fn home_dir() -> AppResult<String> {
    dirs::home_dir()
        .map(|p| p.to_string_lossy().to_string())
        .ok_or_else(|| AppError::Internal {
            reason: "home dir unavailable".to_string(),
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn list_dir_returns_folders_first_alphabetical() {
        let dir = tempfile::tempdir().unwrap();
        fs::create_dir(dir.path().join("zzz_folder")).unwrap();
        fs::create_dir(dir.path().join("aaa_folder")).unwrap();
        let mut f = fs::File::create(dir.path().join("a_file.md")).unwrap();
        writeln!(f, "hi").unwrap();
        let mut f = fs::File::create(dir.path().join("z_file.md")).unwrap();
        writeln!(f, "hi").unwrap();
        let entries = list_dir(dir.path().to_string_lossy().to_string()).unwrap();
        let names: Vec<&str> = entries.iter().map(|e| e.name.as_str()).collect();
        assert_eq!(
            names,
            vec!["aaa_folder", "zzz_folder", "a_file.md", "z_file.md"]
        );
    }

    #[test]
    fn list_dir_paths_have_no_verbatim_prefix() {
        // Regression: canonicalize() adds `\\?\` on Windows; the watcher emits
        // plain paths. If list_dir leaks the prefix, watcher-driven sidebar
        // refreshes key a different string than the rendered tree and new files
        // never show. Trivially passes on non-Windows (no prefix to add).
        let dir = tempfile::tempdir().unwrap();
        fs::create_dir(dir.path().join("docs")).unwrap();
        fs::File::create(dir.path().join("a.md")).unwrap();
        let entries = list_dir(dir.path().to_string_lossy().to_string()).unwrap();
        assert!(!entries.is_empty());
        for e in &entries {
            assert!(
                !e.path.starts_with(r"\\?\"),
                "entry path leaked verbatim prefix: {}",
                e.path
            );
        }
        let docs = entries.iter().find(|e| e.name == "docs").unwrap();
        assert!(docs.path.ends_with("docs"), "got: {}", docs.path);
    }

    #[test]
    fn strip_verbatim_removes_windows_prefixes() {
        assert_eq!(strip_verbatim(Path::new(r"\\?\C:\a\b")), r"C:\a\b");
        assert_eq!(
            strip_verbatim(Path::new(r"\\?\UNC\srv\share")),
            r"\\srv\share"
        );
        assert_eq!(
            strip_verbatim(Path::new(r"C:\already\plain")),
            r"C:\already\plain"
        );
        assert_eq!(strip_verbatim(Path::new("/unix/style")), "/unix/style");
    }

    #[test]
    fn read_then_write_roundtrips() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("test.md").to_string_lossy().to_string();
        write_text_file(path.clone(), "hello".to_string()).unwrap();
        assert_eq!(read_text_file(path).unwrap(), "hello");
    }

    #[test]
    fn read_editor_file_reads_text_with_flags_clear() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("a.rs").to_string_lossy().to_string();
        fs::write(&path, "fn main() {}\n").unwrap();
        let f = read_editor_file(path).unwrap();
        assert_eq!(f.content, "fn main() {}\n");
        assert!(!f.binary);
        assert!(!f.too_large);
        assert_eq!(f.size, 13);
    }

    #[test]
    fn read_editor_file_flags_binary_and_returns_no_content() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("blob.bin").to_string_lossy().to_string();
        // A NUL byte inside the sniff window — valid UTF-8, so only a byte
        // sniff (not read_to_string) catches it.
        fs::write(&path, b"MZ\x00\x00binary\x00payload").unwrap();
        let f = read_editor_file(path).unwrap();
        assert!(f.binary);
        assert_eq!(f.content, "");
    }

    #[test]
    fn read_editor_file_flags_oversized_read_only() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("big.txt").to_string_lossy().to_string();
        // Just over the 1.5 MB cap, all printable ASCII (not binary).
        let big = "a".repeat((EDITOR_SIZE_CAP + 16) as usize);
        fs::write(&path, &big).unwrap();
        let f = read_editor_file(path).unwrap();
        assert!(f.too_large);
        assert!(!f.binary);
        assert!(!f.refused);
        assert_eq!(f.content.len(), big.len());
    }

    #[test]
    fn read_editor_file_refuses_huge_without_reading() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("huge.log").to_string_lossy().to_string();
        // Just over the refuse cap: content must come back EMPTY (never read),
        // not merely read-only — shipping it to the webview is the freeze risk.
        let huge = "b".repeat((EDITOR_REFUSE_CAP + 16) as usize);
        fs::write(&path, &huge).unwrap();
        let f = read_editor_file(path).unwrap();
        assert!(f.refused);
        assert!(f.too_large);
        assert!(!f.binary);
        assert_eq!(f.content, "");
    }
}

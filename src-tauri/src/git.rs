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
/// `worktree add` checks out a full working tree into a new directory — on a
/// large repo that's real disk work, so it gets the most generous deadline.
/// `worktree remove` and `merge` touch the working tree too — same headroom.
const WORKTREE_TIMEOUT: Duration = Duration::from_secs(120);
/// `gh pr create` hits the network — a stingy deadline would spuriously fail on
/// a slow link. gh's own auth/errors still surface via captured stderr.
const GH_TIMEOUT: Duration = Duration::from_secs(30);

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

/// Core spawn for `<program> <args>` in `dir`, always capturing stdout, with a
/// hard timeout and the Windows console-suppression flag. Returns None on spawn
/// failure or timeout.
///
/// Generalised over the program so the `gh` CLI (Plan 013 Land) shares git's
/// exact spawn discipline — CREATE_NO_WINDOW is program-agnostic and the
/// console-flash bug class already shipped once (see the module header). An
/// empty `dir` inherits the process CWD (`gh --version` needs no repo).
///
/// `capture_stderr` decides whether the child's stderr is piped into the
/// returned Output or discarded. The read-only pollers null it (any failure is
/// just "no data" — not a repo, path missing, detached HEAD, …), but the
/// MUTATING commands (worktree add/remove, merge, branch -d, gh pr create) need
/// stderr verbatim so the UI can show the precise message. This opt-in keeps the
/// existing null-stderr behaviour for every read-only caller.
fn run_tool(
    program: &str,
    dir: &str,
    args: &[&str],
    timeout: Duration,
    capture_stderr: bool,
) -> Option<Output> {
    let program = program.to_string();
    let dir = dir.to_string();
    let args: Vec<String> = args.iter().map(|s| s.to_string()).collect();
    let (tx, rx) = mpsc::channel();
    thread::spawn(move || {
        let mut cmd = Command::new(&program);
        cmd.args(&args)
            .stdout(Stdio::piped())
            .stderr(if capture_stderr {
                Stdio::piped()
            } else {
                Stdio::null()
            });
        // Empty dir = inherit the process CWD (a bare `gh --version` probe).
        if !dir.is_empty() {
            cmd.current_dir(&dir);
        }
        #[cfg(windows)]
        cmd.creation_flags(CREATE_NO_WINDOW);
        // Receiver may already be gone (we timed out) — ignore the send error.
        let _ = tx.send(cmd.output());
    });
    rx.recv_timeout(timeout).ok()?.ok()
}

/// Spawn `git <args>` with the shared discipline. `capture_stderr` per `run_tool`.
fn run_git_inner(
    dir: &str,
    args: &[&str],
    timeout: Duration,
    capture_stderr: bool,
) -> Option<Output> {
    run_tool("git", dir, args, timeout, capture_stderr)
}

/// Read-only spawn: stderr discarded (see `run_tool`). Every observation command
/// in this module goes through here.
fn run_git(dir: &str, args: &[&str], timeout: Duration) -> Option<Output> {
    run_git_inner(dir, args, timeout, false)
}

/// Pull git's (or gh's) own words out of a failed `Output`: prefer stderr (where
/// the fatal is written), fall back to stdout, then a generic note. Trimmed.
/// Every mutating command routes its error through here so the UI shows the
/// tool's precise message unedited — the tools' errors are good; we never
/// paraphrase them.
fn tool_message(output: &Output, fallback: &str) -> String {
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    if !stderr.is_empty() {
        return stderr;
    }
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if stdout.is_empty() {
        fallback.to_string()
    } else {
        stdout
    }
}

/// `git rev-parse --abbrev-ref HEAD` — current branch name, or None (not a repo,
/// detached HEAD, missing git, timeout). Unchanged behaviour from Plan 006.
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

// ---------------------------------------------------------------------------
// Attempt worktrees (Plan 013 Phase A). These are the fork-a-repo-into-an-
// isolated-worktree primitives: list bases → add a worktree on a new branch →
// list worktrees to reconcile against reality at boot. `git_worktree_add` is
// the only MUTATING command in this module; it surfaces git's stderr verbatim.
// ---------------------------------------------------------------------------

/// One branch offered as a fork base in the New Attempt popover.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BranchInfo {
    /// Short name: `main` for a local, `origin/main` for a remote.
    pub name: String,
    /// True for the currently checked-out branch (git's `*` HEAD marker).
    pub is_current: bool,
    /// True for a `refs/remotes/*` ref (rendered under the locals in the picker).
    pub is_remote: bool,
}

/// Parse `for-each-ref refs/heads refs/remotes --format=%(refname)%09%(HEAD)`.
///
/// Locals come first (for-each-ref sorts `refs/heads` before `refs/remotes`).
/// `<remote>/HEAD` — the symbolic default-branch pointer, not a real branch —
/// is dropped, and a remote branch whose bare name matches a local is dropped
/// as a twin (offering both `main` and `origin/main` is just noise).
fn parse_branches(text: &str) -> Vec<BranchInfo> {
    let mut locals: Vec<BranchInfo> = Vec::new();
    let mut remotes: Vec<String> = Vec::new();
    let mut local_names: std::collections::HashSet<String> = std::collections::HashSet::new();
    for raw in text.lines() {
        let line = raw.trim_end();
        if line.is_empty() {
            continue;
        }
        // `<refname>\t<marker>`; the marker is `*` for the current branch, a
        // space otherwise (already trimmed off the end above for non-current).
        let (refname, marker) = line.split_once('\t').unwrap_or((line, ""));
        let is_current = marker.trim() == "*";
        if let Some(name) = refname.strip_prefix("refs/heads/") {
            local_names.insert(name.to_string());
            locals.push(BranchInfo {
                name: name.to_string(),
                is_current,
                is_remote: false,
            });
        } else if let Some(name) = refname.strip_prefix("refs/remotes/") {
            if name.ends_with("/HEAD") {
                continue; // origin/HEAD — a pointer, not a branch
            }
            remotes.push(name.to_string());
        }
    }
    let mut out = locals;
    for name in remotes {
        // Strip the remote prefix (first path segment) to get the bare branch.
        let bare = name
            .split_once('/')
            .map(|(_, b)| b)
            .unwrap_or(name.as_str());
        if local_names.contains(bare) {
            continue; // twin of a local branch
        }
        out.push(BranchInfo {
            name,
            is_current: false,
            is_remote: true,
        });
    }
    out
}

/// List local + remote branches to offer as fork bases. Empty on any failure
/// (not a repo, git missing, timeout) — the popover shows an inline error state.
pub fn git_list_branches(repo: String) -> Vec<BranchInfo> {
    let Some(output) = run_git(
        &repo,
        &[
            "for-each-ref",
            "refs/heads",
            "refs/remotes",
            "--format=%(refname)%09%(HEAD)",
        ],
        DIFF_TIMEOUT,
    ) else {
        return Vec::new();
    };
    if !output.status.success() {
        return Vec::new();
    }
    parse_branches(&String::from_utf8_lossy(&output.stdout))
}

/// True if `refs/heads/<name>` resolves — a cheap local-branch existence probe.
fn local_branch_exists(repo: &str, name: &str) -> bool {
    run_git(
        repo,
        &[
            "rev-parse",
            "--verify",
            "--quiet",
            &format!("refs/heads/{name}"),
        ],
        BRANCH_TIMEOUT,
    )
    .map(|o| o.status.success())
    .unwrap_or(false)
}

/// The repo's default branch, used to preselect the base dropdown. Prefers the
/// remote's advertised default (`origin/HEAD` → strip `origin/`); falls back to
/// a local `main`, then `master`, then whatever HEAD currently points at.
pub fn git_default_branch(repo: String) -> Option<String> {
    if let Some(output) = run_git(
        &repo,
        &["symbolic-ref", "--short", "refs/remotes/origin/HEAD"],
        BRANCH_TIMEOUT,
    ) {
        if output.status.success() {
            let full = String::from_utf8_lossy(&output.stdout).trim().to_string();
            // `origin/main` → `main`. Strip only the first segment so a branch
            // name that itself contains slashes (origin/feature/x) survives.
            if let Some((_, branch)) = full.split_once('/') {
                if !branch.is_empty() {
                    return Some(branch.to_string());
                }
            }
        }
    }
    for cand in ["main", "master"] {
        if local_branch_exists(&repo, cand) {
            return Some(cand.to_string());
        }
    }
    git_current_branch(repo)
}

/// Create a worktree at `path` on a new branch `branch` forked from `base`:
/// `git worktree add <path> -b <branch> <base>`. This is the one mutating git
/// call in Lume's whole surface.
///
/// It FAILS LOUD: git's own stderr (branch already exists, path exists, invalid
/// reference) is returned verbatim in the error so the popover can show it
/// unedited — git's messages are precise and we must not paraphrase them.
pub fn git_worktree_add(repo: String, path: String, branch: String, base: String) -> AppResult<()> {
    let output = run_git_inner(
        &repo,
        &["worktree", "add", &path, "-b", &branch, &base],
        WORKTREE_TIMEOUT,
        true,
    )
    .ok_or_else(|| {
        AppError::internal(format!(
            "git worktree add failed to run or timed out in {repo}"
        ))
    })?;
    if output.status.success() {
        return Ok(());
    }
    // Surface git's message verbatim (branch already exists, path exists, invalid
    // reference) so the popover can show it unedited.
    Err(AppError::internal(tool_message(
        &output,
        "git worktree add failed",
    )))
}

/// Check out an EXISTING local branch into a worktree at `path`:
/// `git worktree add <path> <branch>` (no `-b`). The branch-switcher's path for
/// "open this branch in its own terminal" — git itself refuses if the branch is
/// already checked out in another worktree (the safety rail: one branch, one
/// worktree). Fails loud with git's stderr verbatim, like `git_worktree_add`.
pub fn git_worktree_add_existing(repo: String, path: String, branch: String) -> AppResult<()> {
    let output = run_git_inner(
        &repo,
        &["worktree", "add", &path, &branch],
        WORKTREE_TIMEOUT,
        true,
    )
    .ok_or_else(|| {
        AppError::internal(format!(
            "git worktree add failed to run or timed out in {repo}"
        ))
    })?;
    if output.status.success() {
        return Ok(());
    }
    Err(AppError::internal(tool_message(
        &output,
        "git worktree add failed",
    )))
}

/// One worktree attached to a repo (the main checkout plus every attempt).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorktreeEntry {
    /// Absolute path git reports for the worktree.
    pub path: String,
    /// Short branch name (`refs/heads/` stripped); None for a detached worktree.
    pub branch: Option<String>,
}

/// Parse `worktree list --porcelain` into (path, branch) records. The format is
/// blank-line-separated blocks; each starts with `worktree <path>` and may carry
/// `branch refs/heads/<name>` (absent when detached). `HEAD`, `detached`,
/// `bare`, `locked`, … lines are ignored.
fn parse_worktree_porcelain(text: &str) -> Vec<WorktreeEntry> {
    let mut out = Vec::new();
    let mut cur_path: Option<String> = None;
    let mut cur_branch: Option<String> = None;
    let mut flush = |path: &mut Option<String>, branch: &mut Option<String>| {
        if let Some(p) = path.take() {
            out.push(WorktreeEntry {
                path: p,
                branch: branch.take(),
            });
        }
        *branch = None;
    };
    for line in text.lines() {
        if let Some(p) = line.strip_prefix("worktree ") {
            // A new block begins — flush the previous one first (blocks are
            // usually blank-separated, but don't rely on it).
            flush(&mut cur_path, &mut cur_branch);
            cur_path = Some(p.to_string());
        } else if let Some(b) = line.strip_prefix("branch ") {
            cur_branch = Some(b.strip_prefix("refs/heads/").unwrap_or(b).to_string());
        } else if line.is_empty() {
            flush(&mut cur_path, &mut cur_branch);
        }
    }
    flush(&mut cur_path, &mut cur_branch);
    out
}

/// List every worktree attached to `repo` (main checkout + attempts). Used at
/// boot to reconcile attemptStore against reality. Empty on any failure.
pub fn git_worktree_list(repo: String) -> Vec<WorktreeEntry> {
    let Some(output) = run_git(&repo, &["worktree", "list", "--porcelain"], DIFF_TIMEOUT) else {
        return Vec::new();
    };
    if !output.status.success() {
        return Vec::new();
    }
    parse_worktree_porcelain(&String::from_utf8_lossy(&output.stdout))
}

// ---------------------------------------------------------------------------
// Land (Plan 013 Phase B). Turning a finished attempt into a merged/PR'd change
// and cleaning up its worktree. Every MUTATING command here captures the tool's
// stderr and surfaces it verbatim — refuse-and-explain is the whole feature:
// never force, never stash, `branch -d` never `-D`, `worktree remove` never
// --force. `gh` spawns go through the SAME CREATE_NO_WINDOW discipline as git.
// ---------------------------------------------------------------------------

/// The main checkout's branch + cleanliness — the basis for the Land decision
/// (is a local merge even possible?) and the re-checked guard inside a merge.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepoState {
    /// Current branch of the MAIN checkout, or None (detached HEAD / not a repo).
    pub current_branch: Option<String>,
    /// True when `git status --porcelain` is empty (nothing staged/unstaged/
    /// untracked). False on ANY status error — fail safe: refuse a merge onto a
    /// tree we couldn't read rather than risk one.
    pub clean: bool,
}

/// Read (branch, clean) once — shared by the `git_repo_state` command AND the
/// `git_merge_attempt` guard so both judge reality identically.
fn read_repo_state(repo: &str) -> RepoState {
    let current_branch = git_current_branch(repo.to_string());
    let clean = run_git(repo, &["status", "--porcelain", "-z"], DIFF_TIMEOUT)
        .filter(|o| o.status.success())
        .map(|o| o.stdout.is_empty())
        .unwrap_or(false);
    RepoState {
        current_branch,
        clean,
    }
}

/// Current branch + clean flag of a repo's MAIN checkout. Drives the Land menu's
/// "Merge locally" enablement (and its inline refusal reason when disabled).
pub fn git_repo_state(repo: String) -> RepoState {
    read_repo_state(&repo)
}

/// The `origin` remote URL, or None when there's no `origin`. Presence decides
/// whether the Land menu offers a PR / compare-page path at all.
pub fn git_has_remote(repo: String) -> Option<String> {
    let output = run_git(&repo, &["remote", "get-url", "origin"], BRANCH_TIMEOUT)?;
    if !output.status.success() {
        return None;
    }
    let url = String::from_utf8(output.stdout).ok()?.trim().to_string();
    if url.is_empty() {
        None
    } else {
        Some(url)
    }
}

/// `git merge-base <a> <b>` — the common ancestor commit, or None. Read-only.
/// The Diff tab resolves merge-base(HEAD, <baseBranch>) so an attempt session
/// diffs against where it forked, not just its own uncommitted work.
pub fn git_merge_base(repo: String, a: String, b: String) -> Option<String> {
    let output = run_git(&repo, &["merge-base", &a, &b], BRANCH_TIMEOUT)?;
    if !output.status.success() {
        return None;
    }
    let sha = String::from_utf8(output.stdout).ok()?.trim().to_string();
    if sha.is_empty() {
        None
    } else {
        Some(sha)
    }
}

/// Merge an attempt's `branch` into `base` IN THE MAIN CHECKOUT — the one place a
/// local land can happen.
///
/// TOCTOU-safe: the UI checked repo state when it opened the menu, but the user
/// may have switched branches or dirtied the tree since. So the COMMAND ITSELF
/// re-verifies the main checkout is still on `base` and clean at the instant of
/// merge, and refuses with a precise message on any drift WITHOUT touching the
/// repo. On a merge conflict it runs `git merge --abort` immediately — the main
/// checkout is NEVER left mid-merge — and returns git's own conflict text.
pub fn git_merge_attempt(repo: String, branch: String, base: String) -> AppResult<()> {
    // Re-read reality; don't trust the UI's now-possibly-stale snapshot.
    let state = read_repo_state(&repo);
    match state.current_branch.as_deref() {
        Some(cur) if cur == base => {}
        Some(cur) => {
            return Err(AppError::internal(format!(
                "main checkout is on {cur}, not {base} — switch to {base} to merge here, or use a PR"
            )));
        }
        None => {
            return Err(AppError::internal(format!(
                "main checkout is on a detached HEAD — check out {base} to merge here, or use a PR"
            )));
        }
    }
    if !state.clean {
        return Err(AppError::internal(
            "main checkout has uncommitted changes — commit or stash them, or use a PR".to_string(),
        ));
    }

    let output = run_git_inner(
        &repo,
        &["merge", "--no-ff", &branch],
        WORKTREE_TIMEOUT,
        true,
    )
    .ok_or_else(|| AppError::internal(format!("git merge failed to run or timed out in {repo}")))?;
    if output.status.success() {
        return Ok(());
    }

    // Conflict (or other failure): never leave the main checkout mid-merge.
    // Abort first, THEN surface git's own message.
    let _ = run_git_inner(&repo, &["merge", "--abort"], WORKTREE_TIMEOUT, false);
    Err(AppError::internal(tool_message(
        &output,
        "git merge failed",
    )))
}

/// `git worktree remove <path>` in the main repo. NO --force in v1: a dirty
/// worktree MUST refuse (git's stderr says what to clean up). Deleting the user's
/// uncommitted work on their behalf is the exact thing this plan refuses to do.
pub fn git_worktree_remove(repo: String, path: String) -> AppResult<()> {
    let output = run_git_inner(
        &repo,
        &["worktree", "remove", &path],
        WORKTREE_TIMEOUT,
        true,
    )
    .ok_or_else(|| {
        AppError::internal(format!(
            "git worktree remove failed to run or timed out in {repo}"
        ))
    })?;
    if output.status.success() {
        return Ok(());
    }
    Err(AppError::internal(tool_message(
        &output,
        "git worktree remove failed",
    )))
}

/// `git branch -d <branch>` — `-d` ONLY, never `-D`. git refuses to delete an
/// unmerged branch, which is precisely the safety we want (its stderr tells the
/// user the branch isn't merged). Surfaced verbatim.
pub fn git_branch_delete(repo: String, branch: String) -> AppResult<()> {
    let output = run_git_inner(&repo, &["branch", "-d", &branch], BRANCH_TIMEOUT, true)
        .ok_or_else(|| {
            AppError::internal(format!(
                "git branch -d failed to run or timed out in {repo}"
            ))
        })?;
    if output.status.success() {
        return Ok(());
    }
    Err(AppError::internal(tool_message(
        &output,
        "git branch -d failed",
    )))
}

/// Probe whether the GitHub CLI is on PATH (`gh --version`). Cached per app run
/// on the TS side, so this runs at most once. No repo dir needed.
pub fn gh_available() -> bool {
    run_tool("gh", "", &["--version"], BRANCH_TIMEOUT, false)
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// `gh pr create --head <branch> --base <base> --fill` in the WORKTREE dir.
/// Returns the PR URL gh prints on success; on failure returns gh's own stderr
/// verbatim (not authenticated, "no commits between", …) so the UI shows exactly
/// what gh said. Runs under the same CREATE_NO_WINDOW discipline as git.
pub fn gh_pr_create(worktree: String, branch: String, base: String) -> AppResult<String> {
    let output = run_tool(
        "gh",
        &worktree,
        &["pr", "create", "--head", &branch, "--base", &base, "--fill"],
        GH_TIMEOUT,
        true,
    )
    .ok_or_else(|| AppError::internal("gh pr create failed to run or timed out".to_string()))?;
    if output.status.success() {
        let url = String::from_utf8_lossy(&output.stdout).trim().to_string();
        // gh prints the PR URL to stdout; if it's silent, still succeed.
        return Ok(if url.is_empty() {
            "Pull request created".to_string()
        } else {
            url
        });
    }
    Err(AppError::internal(tool_message(
        &output,
        "gh pr create failed",
    )))
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

/// Parse `git diff --name-status -z <base>` — the merge-base changed-file list
/// (Plan 013 Phase B). The -z stream is NUL-terminated fields: a plain change is
/// `STATUS\0PATH`; a rename/copy is `Rxxx\0OLDPATH\0NEWPATH` (a similarity score
/// after the letter, then TWO paths — the second entry must not be mistaken for
/// its own change). Statuses map to the SAME normalised kinds as the status
/// parser so the UI renders one glyph vocabulary regardless of diff base.
fn parse_diff_name_status_z(data: &str) -> Vec<ChangedFile> {
    let mut out = Vec::new();
    let mut fields = data.split('\0');
    while let Some(status_field) = fields.next() {
        if status_field.is_empty() {
            continue; // trailing empty field after the final NUL
        }
        let code = status_field.as_bytes()[0] as char;
        match code {
            // Rename/copy: the status field is followed by OLD then NEW.
            'R' | 'C' => {
                let (Some(old), Some(new)) = (fields.next(), fields.next()) else {
                    break; // truncated stream — stop rather than misread
                };
                out.push(ChangedFile {
                    status: if code == 'R' { "renamed" } else { "added" }.to_string(),
                    path: new.to_string(),
                    old_path: Some(old.to_string()),
                });
            }
            _ => {
                let Some(path) = fields.next() else {
                    break;
                };
                let status = match code {
                    'A' => "added",
                    'D' => "deleted",
                    // M (modified), T (typechange) and any other single-file
                    // change render as a modification.
                    _ => "modified",
                };
                out.push(ChangedFile {
                    status: status.to_string(),
                    path: path.to_string(),
                    old_path: None,
                });
            }
        }
    }
    out
}

/// List a repo's changed files. `base` None → working tree vs HEAD via
/// `git status` (Plan 010B, the default for every non-attempt session). `base`
/// Some(rev) → `git diff --name-status <rev>` so an attempt session lists
/// EVERYTHING it changed since it forked (merge-base), not just uncommitted work
/// vs HEAD. Errors (missing git, deleted repo) surface as an AppError the store
/// turns into an empty-state, not a toast.
pub fn git_changed_files(repo: String, base: Option<String>) -> AppResult<Vec<ChangedFile>> {
    if let Some(base) = base {
        let output = run_git(&repo, &["diff", "--name-status", "-z", &base], DIFF_TIMEOUT)
            .ok_or_else(|| AppError::Internal {
                reason: format!("git diff failed or timed out in {repo}"),
            })?;
        if !output.status.success() {
            return Err(AppError::Internal {
                reason: format!("git diff exited non-zero in {repo}"),
            });
        }
        let text = String::from_utf8_lossy(&output.stdout);
        return Ok(parse_diff_name_status_z(&text));
    }

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
///   - modified: old = <base>:path,     new = working file
///   - added / untracked: old = "",      new = working file
///   - deleted: old = <base>:path,       new = ""
///   - renamed: old = <base>:old_path,   new = working file at path
///
/// `base` is the ref for the old side — HEAD by default (Plan 010B), or the
/// merge-base SHA for an attempt session (Plan 013 Phase B), matching whatever
/// base `git_changed_files` listed against so the two stay coherent.
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

pub fn git_file_diff(
    repo: String,
    path: String,
    old_path: Option<String>,
    base: Option<String>,
) -> AppResult<FileDiff> {
    // Old side: the blob at the diff base. For a rename that's the pre-rename
    // path. A git failure here means "not in <base>" (added) → empty old side.
    let old_rel = old_path.as_deref().unwrap_or(&path);
    let base_ref = base.as_deref().unwrap_or("HEAD");
    let old_bytes = run_git(
        &repo,
        &["show", &format!("{base_ref}:{old_rel}")],
        DIFF_TIMEOUT,
    )
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

// ---------------------------------------------------------------------------
// Async command shims (Plan 001, hot subset — the freeze fix).
//
// Tauri v2 runs SYNC commands on the MAIN thread. Every function above blocks
// on a spawned `git`/`gh` for up to WORKTREE_TIMEOUT (120 s) — and the branch
// poller calls one every 5 s. On OneDrive-synced repos a sync burst can stall
// git for whole seconds, during which the main thread — and therefore EVERY
// queued IPC call, including the user's pty_write keystrokes — freezes, then
// floods back ("terminal froze, then slowly caught up"). These shims keep the
// tested sync bodies and wire names identical but hop the work onto the async
// runtime's dedicated BLOCKING pool, so a slow git can never stall the app.
//
// Join failures (a panicked blocking task) degrade to each command's "no
// data" shape — the same stance the sync bodies already take toward git
// failures. pty.rs commands are deliberately NOT converted: per-keystroke
// writes are cheap, and async commands lose cross-call ordering, which
// keystrokes require.
// ---------------------------------------------------------------------------

pub mod cmd {
    use super::*;
    use crate::error::AppError;

    async fn blocking<T: Send + 'static>(
        f: impl FnOnce() -> T + Send + 'static,
    ) -> Result<T, AppError> {
        tauri::async_runtime::spawn_blocking(f)
            .await
            .map_err(|e| AppError::internal(format!("blocking task join: {e}")))
    }

    #[tauri::command]
    pub async fn git_current_branch(path: String) -> Option<String> {
        blocking(move || super::git_current_branch(path))
            .await
            .ok()
            .flatten()
    }

    #[tauri::command]
    pub async fn git_repo_root(path: String) -> Option<String> {
        blocking(move || super::git_repo_root(path))
            .await
            .ok()
            .flatten()
    }

    #[tauri::command]
    pub async fn git_list_branches(repo: String) -> Vec<BranchInfo> {
        blocking(move || super::git_list_branches(repo))
            .await
            .unwrap_or_default()
    }

    #[tauri::command]
    pub async fn git_default_branch(repo: String) -> Option<String> {
        blocking(move || super::git_default_branch(repo))
            .await
            .ok()
            .flatten()
    }

    #[tauri::command]
    pub async fn git_worktree_add(
        repo: String,
        path: String,
        branch: String,
        base: String,
    ) -> AppResult<()> {
        blocking(move || super::git_worktree_add(repo, path, branch, base)).await?
    }

    #[tauri::command]
    pub async fn git_worktree_add_existing(
        repo: String,
        path: String,
        branch: String,
    ) -> AppResult<()> {
        blocking(move || super::git_worktree_add_existing(repo, path, branch)).await?
    }

    #[tauri::command]
    pub async fn git_worktree_list(repo: String) -> Vec<WorktreeEntry> {
        blocking(move || super::git_worktree_list(repo))
            .await
            .unwrap_or_default()
    }

    #[tauri::command]
    pub async fn git_repo_state(repo: String) -> RepoState {
        blocking(move || super::git_repo_state(repo))
            .await
            .unwrap_or(RepoState {
                current_branch: None,
                clean: false,
            })
    }

    #[tauri::command]
    pub async fn git_has_remote(repo: String) -> Option<String> {
        blocking(move || super::git_has_remote(repo))
            .await
            .ok()
            .flatten()
    }

    #[tauri::command]
    pub async fn git_merge_base(repo: String, a: String, b: String) -> Option<String> {
        blocking(move || super::git_merge_base(repo, a, b))
            .await
            .ok()
            .flatten()
    }

    #[tauri::command]
    pub async fn git_merge_attempt(repo: String, branch: String, base: String) -> AppResult<()> {
        blocking(move || super::git_merge_attempt(repo, branch, base)).await?
    }

    #[tauri::command]
    pub async fn git_worktree_remove(repo: String, path: String) -> AppResult<()> {
        blocking(move || super::git_worktree_remove(repo, path)).await?
    }

    #[tauri::command]
    pub async fn git_branch_delete(repo: String, branch: String) -> AppResult<()> {
        blocking(move || super::git_branch_delete(repo, branch)).await?
    }

    #[tauri::command]
    pub async fn gh_available() -> bool {
        blocking(super::gh_available).await.unwrap_or(false)
    }

    #[tauri::command]
    pub async fn gh_pr_create(worktree: String, branch: String, base: String) -> AppResult<String> {
        blocking(move || super::gh_pr_create(worktree, branch, base)).await?
    }

    #[tauri::command]
    pub async fn git_changed_files(
        repo: String,
        base: Option<String>,
    ) -> AppResult<Vec<ChangedFile>> {
        blocking(move || super::git_changed_files(repo, base)).await?
    }

    #[tauri::command]
    pub async fn git_file_diff(
        repo: String,
        path: String,
        old_path: Option<String>,
        base: Option<String>,
    ) -> AppResult<FileDiff> {
        blocking(move || super::git_file_diff(repo, path, old_path, base)).await?
    }
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

    /// Capture a git command's trimmed stdout (test-only convenience).
    fn git_out(dir: &Path, args: &[&str]) -> String {
        let out = StdCommand::new("git")
            .args(args)
            .current_dir(dir)
            .stderr(Stdio::null())
            .output()
            .expect("spawn git");
        String::from_utf8_lossy(&out.stdout).trim().to_string()
    }

    /// Probe whether `gh` is on PATH — Land's gh tests skip (not fail) without it,
    /// mirroring `git_available` so a bare CI image still runs the suite.
    fn gh_on_path() -> bool {
        StdCommand::new("gh")
            .arg("--version")
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .map(|s| s.success())
            .unwrap_or(false)
    }

    /// Init a repo on a KNOWN default branch (`main`) with one commit, so tests
    /// don't depend on the host's `init.defaultBranch`. Returns nothing; the repo
    /// is left checked out on `main`.
    fn init_repo_on_main(dir: &Path) {
        init_repo(dir);
        git_in(dir, &["checkout", "-q", "-b", "main"]);
        std::fs::write(dir.join("seed.txt"), "seed\n").unwrap();
        git_in(dir, &["add", "."]);
        git_in(dir, &["commit", "-q", "-m", "init"]);
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

        let files = git_changed_files(root.to_string_lossy().to_string(), None).unwrap();
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

        let files = git_changed_files(root.to_string_lossy().to_string(), None).unwrap();
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
            None,
        )
        .unwrap();
        assert!(d.binary);
        assert_eq!(d.new_text, "");
    }

    // ---- Plan 013 pure parsers (no git needed) ----

    #[test]
    fn parse_branches_splits_locals_and_marks_current() {
        let text = "refs/heads/main\t*\nrefs/heads/feature\t \n";
        let got = parse_branches(text);
        assert_eq!(got.len(), 2);
        assert_eq!(got[0].name, "main");
        assert!(got[0].is_current);
        assert!(!got[0].is_remote);
        assert_eq!(got[1].name, "feature");
        assert!(!got[1].is_current);
    }

    #[test]
    fn parse_branches_drops_origin_head_and_local_twins() {
        // origin/HEAD is a pointer (dropped); origin/main twins the local main
        // (dropped); origin/solo has no local twin (kept, marked remote). Locals
        // are emitted before remotes regardless of input order.
        let text = "\
refs/heads/main\t*
refs/remotes/origin/HEAD\t
refs/remotes/origin/main\t
refs/remotes/origin/solo\t
";
        let got = parse_branches(text);
        let names: Vec<&str> = got.iter().map(|b| b.name.as_str()).collect();
        assert_eq!(names, vec!["main", "origin/solo"]);
        assert!(!got[0].is_remote && got[1].is_remote);
    }

    #[test]
    fn parse_branches_empty_is_no_branches() {
        assert!(parse_branches("").is_empty());
        assert!(parse_branches("\n\n").is_empty());
    }

    #[test]
    fn parse_worktree_porcelain_reads_path_and_branch() {
        let text = "\
worktree /repo/main
HEAD deadbeef
branch refs/heads/main

worktree /repo/wt-x
HEAD cafef00d
branch refs/heads/lume/my-attempt

worktree /repo/detached
HEAD 0badc0de
detached
";
        let got = parse_worktree_porcelain(text);
        assert_eq!(got.len(), 3);
        assert_eq!(got[0].path, "/repo/main");
        assert_eq!(got[0].branch.as_deref(), Some("main"));
        assert_eq!(got[1].path, "/repo/wt-x");
        assert_eq!(got[1].branch.as_deref(), Some("lume/my-attempt"));
        assert_eq!(got[2].path, "/repo/detached");
        assert_eq!(got[2].branch, None);
    }

    #[test]
    fn parse_worktree_porcelain_handles_missing_trailing_blank() {
        // git omits the trailing blank line on the final block — it must still
        // flush rather than being dropped.
        let text = "worktree /only\nHEAD abc\nbranch refs/heads/solo";
        let got = parse_worktree_porcelain(text);
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].branch.as_deref(), Some("solo"));
    }

    // ---- Plan 013 fixture-repo integration tests ----

    #[test]
    fn list_branches_reports_locals_and_current() {
        if !git_available() {
            return;
        }
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        init_repo(root);
        std::fs::write(root.join("f.txt"), "x\n").unwrap();
        git_in(root, &["add", "."]);
        git_in(root, &["commit", "-q", "-m", "init"]);
        git_in(root, &["branch", "feature"]);

        let branches = git_list_branches(root.to_string_lossy().to_string());
        let current = git_current_branch(root.to_string_lossy().to_string()).unwrap();
        assert!(branches.iter().any(|b| b.name == "feature" && !b.is_remote));
        assert!(branches.iter().any(|b| b.name == current && b.is_current));
        // Exactly one branch is current.
        assert_eq!(branches.iter().filter(|b| b.is_current).count(), 1);
    }

    #[test]
    fn default_branch_falls_back_to_current_without_remote() {
        if !git_available() {
            return;
        }
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        init_repo(root);
        git_in(root, &["commit", "-q", "--allow-empty", "-m", "init"]);
        // No remote configured, so origin/HEAD lookup fails and it falls through
        // to the local main/master (== the checked-out branch) fallback.
        let def = git_default_branch(root.to_string_lossy().to_string());
        let current = git_current_branch(root.to_string_lossy().to_string());
        assert_eq!(def, current);
        assert!(matches!(def.as_deref(), Some("main") | Some("master")));
    }

    #[test]
    fn worktree_add_creates_branch_dir_and_lists() {
        if !git_available() {
            return;
        }
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        init_repo(root);
        std::fs::write(root.join("seed.txt"), "seed\n").unwrap();
        git_in(root, &["add", "."]);
        git_in(root, &["commit", "-q", "-m", "init"]);

        let wt = root.join("wt-attempt");
        let res = git_worktree_add(
            root.to_string_lossy().to_string(),
            wt.to_string_lossy().to_string(),
            "lume/my-attempt".to_string(),
            "HEAD".to_string(),
        );
        assert!(res.is_ok(), "worktree add should succeed: {res:?}");
        assert!(wt.join("seed.txt").exists(), "worktree checked out files");

        let list = git_worktree_list(root.to_string_lossy().to_string());
        assert!(
            list.iter()
                .any(|e| e.branch.as_deref() == Some("lume/my-attempt")),
            "new attempt branch should appear in worktree list: {list:?}"
        );
    }

    #[test]
    fn worktree_add_fails_loud_on_existing_branch() {
        if !git_available() {
            return;
        }
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        init_repo(root);
        git_in(root, &["commit", "-q", "--allow-empty", "-m", "init"]);
        let current = git_current_branch(root.to_string_lossy().to_string()).unwrap();

        // Forking a NEW branch whose name already exists (the current branch)
        // must fail, and the error must carry git's own words.
        let wt = root.join("wt-dupe");
        let res = git_worktree_add(
            root.to_string_lossy().to_string(),
            wt.to_string_lossy().to_string(),
            current,
            "HEAD".to_string(),
        );
        let err = res.expect_err("existing branch must fail loud");
        let AppError::Internal { reason } = err else {
            panic!("expected Internal error");
        };
        assert!(
            reason.to_lowercase().contains("exists"),
            "git's message should surface verbatim, got: {reason}"
        );
    }

    #[test]
    fn worktree_add_existing_checks_out_and_refuses_double_checkout() {
        if !git_available() {
            return;
        }
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        init_repo(root);
        std::fs::write(root.join("seed.txt"), "seed\n").unwrap();
        git_in(root, &["add", "."]);
        git_in(root, &["commit", "-q", "-m", "init"]);
        git_in(root, &["branch", "feature/x"]);

        // Existing branch → worktree checkout (the branch-switcher's path).
        let wt = root.join("wt-feature-x");
        let res = git_worktree_add_existing(
            root.to_string_lossy().to_string(),
            wt.to_string_lossy().to_string(),
            "feature/x".to_string(),
        );
        assert!(
            res.is_ok(),
            "existing-branch checkout should succeed: {res:?}"
        );
        assert!(wt.join("seed.txt").exists());

        // Git's one-branch-one-worktree rail: a second checkout of the same
        // branch must refuse with git's own words.
        let wt2 = root.join("wt-feature-x-2");
        let err = git_worktree_add_existing(
            root.to_string_lossy().to_string(),
            wt2.to_string_lossy().to_string(),
            "feature/x".to_string(),
        )
        .expect_err("double checkout must refuse");
        let AppError::Internal { reason } = err else {
            panic!("expected Internal error");
        };
        assert!(
            reason.to_lowercase().contains("already"),
            "git's message should surface verbatim, got: {reason}"
        );
    }

    // ---- Plan 013 Phase B pure parsers (no git needed) ----

    #[test]
    fn parse_diff_name_status_maps_plain_changes() {
        // `M\0a.rs\0A\0b.rs\0D\0c.rs\0` — one status + one path each.
        let data = "M\0a.rs\0A\0b.rs\0D\0c.rs\0";
        let files = parse_diff_name_status_z(data);
        assert_eq!(files.len(), 3);
        assert_eq!(
            (files[0].status.as_str(), files[0].path.as_str()),
            ("modified", "a.rs")
        );
        assert_eq!(
            (files[1].status.as_str(), files[1].path.as_str()),
            ("added", "b.rs")
        );
        assert_eq!(
            (files[2].status.as_str(), files[2].path.as_str()),
            ("deleted", "c.rs")
        );
        assert!(files.iter().all(|f| f.old_path.is_none()));
    }

    #[test]
    fn parse_diff_name_status_reads_rename_two_paths() {
        // `R100\0old.rs\0new.rs\0M\0other.rs\0` — the rename consumes TWO paths;
        // `other.rs` must remain its own entry, not be swallowed.
        let data = "R100\0old.rs\0new.rs\0M\0other.rs\0";
        let files = parse_diff_name_status_z(data);
        assert_eq!(files.len(), 2, "rename must consume exactly its two paths");
        assert_eq!(files[0].status, "renamed");
        assert_eq!(files[0].path, "new.rs");
        assert_eq!(files[0].old_path.as_deref(), Some("old.rs"));
        assert_eq!(files[1].status, "modified");
        assert_eq!(files[1].path, "other.rs");
    }

    #[test]
    fn parse_diff_name_status_empty_is_no_files() {
        assert!(parse_diff_name_status_z("").is_empty());
        assert!(parse_diff_name_status_z("\0").is_empty());
    }

    // ---- Plan 013 Phase B fixture-repo integration tests ----

    #[test]
    fn repo_state_reports_branch_and_cleanliness() {
        if !git_available() {
            return;
        }
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        init_repo_on_main(root);

        let clean = git_repo_state(root.to_string_lossy().to_string());
        assert_eq!(clean.current_branch.as_deref(), Some("main"));
        assert!(clean.clean, "a freshly-committed tree is clean");

        std::fs::write(root.join("seed.txt"), "seed\ndirty\n").unwrap();
        let dirty = git_repo_state(root.to_string_lossy().to_string());
        assert_eq!(dirty.current_branch.as_deref(), Some("main"));
        assert!(!dirty.clean, "an uncommitted change makes it dirty");
    }

    #[test]
    fn has_remote_none_then_some() {
        if !git_available() {
            return;
        }
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        init_repo_on_main(root);

        assert_eq!(git_has_remote(root.to_string_lossy().to_string()), None);
        git_in(
            root,
            &["remote", "add", "origin", "https://example.com/x.git"],
        );
        assert_eq!(
            git_has_remote(root.to_string_lossy().to_string()).as_deref(),
            Some("https://example.com/x.git")
        );
    }

    #[test]
    fn merge_base_is_the_fork_point() {
        if !git_available() {
            return;
        }
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        init_repo_on_main(root); // commit A on main
        let fork = git_out(root, &["rev-parse", "HEAD"]); // A
        git_in(root, &["branch", "feature"]); // feature at A
        std::fs::write(root.join("seed.txt"), "seed\nB\n").unwrap();
        git_in(root, &["commit", "-qam", "B"]); // main advances to B

        let mb = git_merge_base(
            root.to_string_lossy().to_string(),
            "main".to_string(),
            "feature".to_string(),
        );
        assert_eq!(
            mb.as_deref(),
            Some(fork.as_str()),
            "merge-base is the fork commit A"
        );
    }

    #[test]
    fn changed_files_against_base_lists_committed_branch_work() {
        if !git_available() {
            return;
        }
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        init_repo_on_main(root);
        let base = git_out(root, &["rev-parse", "HEAD"]);
        // A committed change on the branch (NOT reflected by `git status`).
        std::fs::write(root.join("feat.txt"), "feature\n").unwrap();
        git_in(root, &["add", "."]);
        git_in(root, &["commit", "-qm", "feat"]);

        // vs HEAD: clean (the change is committed).
        let vs_head = git_changed_files(root.to_string_lossy().to_string(), None).unwrap();
        assert!(vs_head.is_empty(), "committed work is invisible vs HEAD");
        // vs base: the committed addition shows up.
        let vs_base = git_changed_files(root.to_string_lossy().to_string(), Some(base)).unwrap();
        assert!(
            vs_base
                .iter()
                .any(|f| f.path == "feat.txt" && f.status == "added"),
            "merge-base diff surfaces committed branch work: {vs_base:?}"
        );
    }

    #[test]
    fn merge_attempt_happy_path_lands_branch() {
        if !git_available() {
            return;
        }
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        init_repo_on_main(root);

        // Fork an attempt worktree OUTSIDE the repo (the real design — a nested
        // worktree would show as untracked and dirty the main checkout), commit
        // work on it.
        let wt_home = tempfile::tempdir().unwrap();
        let wt = wt_home.path().join("wt");
        git_worktree_add(
            root.to_string_lossy().to_string(),
            wt.to_string_lossy().to_string(),
            "lume/x".to_string(),
            "main".to_string(),
        )
        .unwrap();
        std::fs::write(wt.join("added.txt"), "from attempt\n").unwrap();
        git_in(&wt, &["add", "."]);
        git_in(&wt, &["commit", "-qm", "attempt work"]);

        // Main is on main + clean → merge succeeds and the file lands.
        let res = git_merge_attempt(
            root.to_string_lossy().to_string(),
            "lume/x".to_string(),
            "main".to_string(),
        );
        assert!(
            res.is_ok(),
            "clean fast-forwardable merge should succeed: {res:?}"
        );
        assert!(
            root.join("added.txt").exists(),
            "merged file is in the main checkout"
        );
    }

    #[test]
    fn merge_attempt_refuses_wrong_branch() {
        if !git_available() {
            return;
        }
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        init_repo_on_main(root);
        git_in(root, &["checkout", "-q", "-b", "other"]); // main checkout on `other`

        let err = git_merge_attempt(
            root.to_string_lossy().to_string(),
            "lume/x".to_string(),
            "main".to_string(),
        )
        .expect_err("merge must refuse when main isn't on the base branch");
        let AppError::Internal { reason } = err else {
            panic!("expected Internal error");
        };
        assert!(
            reason.contains("other") && reason.contains("main"),
            "refusal names the current branch and the base: {reason}"
        );
    }

    #[test]
    fn merge_attempt_refuses_dirty_tree() {
        if !git_available() {
            return;
        }
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        init_repo_on_main(root);
        let wt_home = tempfile::tempdir().unwrap();
        git_worktree_add(
            root.to_string_lossy().to_string(),
            wt_home.path().join("wt").to_string_lossy().to_string(),
            "lume/x".to_string(),
            "main".to_string(),
        )
        .unwrap();
        // Dirty the MAIN checkout.
        std::fs::write(root.join("seed.txt"), "seed\nlocal edit\n").unwrap();

        let err = git_merge_attempt(
            root.to_string_lossy().to_string(),
            "lume/x".to_string(),
            "main".to_string(),
        )
        .expect_err("merge must refuse a dirty main checkout");
        let AppError::Internal { reason } = err else {
            panic!("expected Internal error");
        };
        assert!(
            reason.to_lowercase().contains("uncommitted"),
            "refusal explains the dirty tree: {reason}"
        );
    }

    #[test]
    fn merge_attempt_aborts_on_conflict_and_leaves_no_merge_state() {
        if !git_available() {
            return;
        }
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        init_repo_on_main(root);

        // Attempt edits seed.txt; main edits the SAME line differently → conflict.
        // Worktree lives outside the repo (see happy-path note).
        let wt_home = tempfile::tempdir().unwrap();
        let wt = wt_home.path().join("wt");
        git_worktree_add(
            root.to_string_lossy().to_string(),
            wt.to_string_lossy().to_string(),
            "lume/x".to_string(),
            "main".to_string(),
        )
        .unwrap();
        std::fs::write(wt.join("seed.txt"), "seed from attempt\n").unwrap();
        git_in(&wt, &["commit", "-qam", "attempt edit"]);
        std::fs::write(root.join("seed.txt"), "seed from main\n").unwrap();
        git_in(root, &["commit", "-qam", "main edit"]);

        let err = git_merge_attempt(
            root.to_string_lossy().to_string(),
            "lume/x".to_string(),
            "main".to_string(),
        )
        .expect_err("a conflicting merge must fail");
        let AppError::Internal { reason } = err else {
            panic!("expected Internal error");
        };
        assert!(!reason.is_empty(), "git's conflict message surfaces");
        // The abort must have run — no MERGE_HEAD left behind, tree clean again.
        assert!(
            !root.join(".git/MERGE_HEAD").exists(),
            "merge was aborted; no MERGE_HEAD remains"
        );
        assert!(
            git_repo_state(root.to_string_lossy().to_string()).clean,
            "main checkout is clean after the abort"
        );
    }

    #[test]
    fn worktree_remove_refuses_dirty_then_removes_clean() {
        if !git_available() {
            return;
        }
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        init_repo_on_main(root);
        let wt = root.join("wt");
        git_worktree_add(
            root.to_string_lossy().to_string(),
            wt.to_string_lossy().to_string(),
            "lume/x".to_string(),
            "main".to_string(),
        )
        .unwrap();

        // Dirty the worktree → remove refuses with git's own words.
        std::fs::write(wt.join("scratch.txt"), "uncommitted\n").unwrap();
        let err = git_worktree_remove(
            root.to_string_lossy().to_string(),
            wt.to_string_lossy().to_string(),
        )
        .expect_err("a dirty worktree must refuse removal");
        let AppError::Internal { reason } = err else {
            panic!("expected Internal error");
        };
        assert!(
            !reason.is_empty(),
            "git's refusal surfaces verbatim: {reason}"
        );
        assert!(wt.exists(), "worktree still present after a refused remove");

        // Clean it up → remove succeeds.
        std::fs::remove_file(wt.join("scratch.txt")).unwrap();
        git_worktree_remove(
            root.to_string_lossy().to_string(),
            wt.to_string_lossy().to_string(),
        )
        .expect("a clean worktree removes");
        assert!(!wt.exists(), "worktree directory is gone");
    }

    #[test]
    fn branch_delete_refuses_unmerged_then_deletes_merged() {
        if !git_available() {
            return;
        }
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        init_repo_on_main(root);

        // An unmerged branch: `-d` must refuse (never `-D`).
        git_in(root, &["checkout", "-q", "-b", "stray"]);
        std::fs::write(root.join("stray.txt"), "unmerged\n").unwrap();
        git_in(root, &["add", "."]);
        git_in(root, &["commit", "-qm", "stray work"]);
        git_in(root, &["checkout", "-q", "main"]);

        let err = git_branch_delete(root.to_string_lossy().to_string(), "stray".to_string())
            .expect_err("an unmerged branch must refuse -d");
        let AppError::Internal { reason } = err else {
            panic!("expected Internal error");
        };
        assert!(
            reason.to_lowercase().contains("not fully merged")
                || reason.to_lowercase().contains("not merged"),
            "git explains the branch isn't merged: {reason}"
        );

        // A merged branch deletes cleanly.
        git_in(root, &["branch", "merged-twin"]); // points at HEAD → merged
        git_branch_delete(
            root.to_string_lossy().to_string(),
            "merged-twin".to_string(),
        )
        .expect("a merged branch deletes with -d");
    }

    #[test]
    fn gh_pr_create_fails_loud_outside_a_repo() {
        // gh's error path without hitting the network: in a plain (non-git) dir
        // gh fails fast. Skipped when gh isn't installed (Land degrades to the
        // compare-page fallback there).
        if !gh_on_path() {
            return;
        }
        let dir = tempfile::tempdir().unwrap();
        let res = gh_pr_create(
            dir.path().to_string_lossy().to_string(),
            "lume/x".to_string(),
            "main".to_string(),
        );
        assert!(
            res.is_err(),
            "gh pr create outside a repo must error, not hang"
        );
    }
}

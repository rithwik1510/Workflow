# Plan 010: Code editor in split view → git diff tab (Output layer)

## Status

APPROVED — operator-directed 2026-07-02. Two phases, strictly ordered:
**Phase A** generalizes the existing MD editor to all text/code files
(open + edit + save in split view, Codex-GUI feel). **Phase B** adds the
per-session **Diff tab** (top-right button → right-side surface, like the
MD Editor Full View pattern), rendered with the same editor stack.
Phase A ships alone first; B builds on its foundations.

Execution: worktree branch per repo convention; reviewed before merge.

## Goal

Agents produce code; today Lume can only *view/edit* `.md`. The operator's
review loop should close inside Lume:

- **A:** open any code file from the drawer / Ctrl+O into editor tabs in the
  split surface, with syntax highlighting, edit + save (existing atomic-write
  pipeline), and **agent-safe external-change handling**.
- **B:** one click ("Diff", top-right of the session view) opens a right tab:
  changed-files list + side-by-side/unified diff of the working tree —
  Conductor-style, powered entirely by git.

**Product boundary:** pure observation of the filesystem/git. No tracking of
"what the agent edited" — **git IS the tracking layer**. No attribution, no
agent introspection.

## Why git-diff, not agent-tracking

A session's panes have known cwds (`ptyStore`). cwd → `git rev-parse
--show-toplevel` → repository → `git status` + `git diff` = exactly the work
done in that workspace since HEAD/base. In the (planned) worktree-per-session
world this is *precisely* "what this session's agents did", with zero new
machinery and zero drift when agent internals change.

**Multi-terminal answer (operator's question):** the diff is per-REPOSITORY,
not per-pane. Multiple panes of one session usually share one repo — per-pane
diff buttons would show N copies of the same diff. So: derive the distinct
repo set from all the session's pane cwds; one repo (the common case) → the
Diff tab just opens; several → a repo dropdown in the Diff tab header. A pane
whose cwd is not in any repo contributes nothing (empty-state text explains).

## Phase A — editor for all text files

Foundation already present: `mdStore` tabs are path-based with `dirty`,
save-through-`fsClient` (atomic writes, Plan 005), dirty-close confirm,
Ctrl+S/W/Tab handling, split surface, file drawer + `openPath.ts`.

1. **Language support:** `@codemirror/language-data` for lazy per-extension
   highlighter loading (~150 languages, loaded on first open of that type —
   also fits the deferred audit note about the eager CodeMirror bundle;
   `React.lazy` the editor surfaces while in there if cheap).
2. **Open path:** file drawer and Ctrl+O accept any file. Guards: size cap
   (1.5 MB → read-only warning banner above the editor), binary sniff (NUL
   byte in first 8 KB → refuse with toast). Markdown keeps its preview mode;
   code files get plain editor (no preview toggle).
3. **External-change watcher — the agent-safety feature, non-negotiable:**
   a Rust `notify` watcher per open tab path (same infra family as the 008
   spool watcher) emitting a `file-changed` Tauri event.
   - tab clean → silently reload from disk;
   - tab dirty → conflict bar: "Changed on disk — [Reload] [Keep mine]";
   - save writes also bump a self-write marker so our own atomic save does
     not trigger the bar (compare mtime/hash or suppress-during-save flag).
4. **Naming:** keep `mdStore` module (avoid churn) but rename types/UI copy
   from "MD Editor" to "Editor" where user-visible; tab type gains a
   `kind: "markdown" | "code"` discriminator.
5. Tests: language pick by extension, size/binary guards, watcher reload vs
   conflict-bar matrix (self-write suppression!), existing MD suites stay
   green.

## Phase B — the Diff tab

1. **Entry point:** "Diff" button top-right (session header area, near the
   existing surface toggles). Opens a right-side surface exactly like MD
   Editor Full View (`mdEditorMode` pattern → a `diff` surface mode).
   Keyboard: Ctrl+D if free, else document actual pick in ShortcutsModal.
2. **Repo derivation:** session layout leaves → `ptyStore.cwd` per pane
   (fallback: session project path) → dedupe via `git rev-parse
   --show-toplevel`. One repo → straight in; N repos → dropdown in header.
3. **Data:** `git status --porcelain=v1 -z` for the changed-file list;
   per-file `git diff HEAD -- <file>` (untracked files render as whole-file
   additions; binary files listed but not rendered). ALL git spawns set
   CREATE_NO_WINDOW (see lume-windows-subprocess-flicker — this class of bug
   already bit us once).
4. **Rendering:** `@codemirror/merge` — unified by default, side-by-side
   toggle. Same theme/fonts as the editor. Read-only in v1; each file row
   and diff header has "Open in editor" → jumps into a Phase A tab.
5. **Refresh:** manual refresh button + piggyback on the single-flight git
   poller (Plan 006) so the list stays fresh without a second polling system.
6. **Base selector (stretch, keep if cheap):** default diff vs HEAD;
   dropdown alternative "vs merge-base with default branch" for the
   worktree-review use case. If not cheap, ship HEAD-only and note it.
7. Tests: repo derivation (multi-pane/multi-repo/non-repo matrix), porcelain
   parsing incl. renames + `-z` splitting, untracked/binary handling,
   surface open/close + focus behavior.

## Testing gates

- vitest + cargo green, typecheck + build clean, clippy/fmt clean.
- Diff logic tested against fixture repos created in temp dirs (never the
  Lume repo itself); watcher tests use scratch files.
- Manual GUI gate (operator): agent edits a file that's open in a dirty tab
  → conflict bar; Diff tab against a session with real changes; multi-repo
  session shows the dropdown.

## Risks / edge cases

- **Huge diffs:** cap rendered diff per file (e.g. 10k lines → "open in
  editor to view"); the list itself is cheap.
- **Repos on WSL paths (`\\wsl$\...`):** UNC handling exists elsewhere in
  the app; verify `rev-parse` output normalization on Windows.
- **Submodules/nested repos:** `--show-toplevel` per cwd handles it
  naturally — nested repo panes just surface as a second repo entry.
- **Watcher fd cost:** one watcher per open tab is bounded by tab count;
  reuse a single watcher instance with a path set if `notify` makes it easy.

## Out of scope

Staging/commit UI, hunk editing, agent attribution, PR creation, worktree
lifecycle button (its own future plan — this Diff tab is what makes it
valuable), scrollback search.

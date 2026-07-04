# Changelog

All notable changes to Lume are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); this project uses
[Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.1.0] — 2026-07-04

Out of beta. The two loops close: your agents reach you when you're away,
and work starts, gets reviewed, and lands — all without leaving Lume.

### Added
- **New attempt — fork a repo into an isolated worktree.** Right-click a repo
  session → **New attempt…**, pick a base branch, and Lume creates a git
  worktree on a fresh `lume/<name>` branch under `~\lume\worktrees\<repo>\`,
  opens a session there, and groups it under the repo. Your repo never moves;
  a running agent is never rug-pulled by an in-place checkout. A one-time hint
  reminds you to install deps in the fresh worktree (Lume never runs it for
  you). The base picker and creation surface match the app's popover language.
- **Diff tab — review what your agents did (`Ctrl+Shift+D`).** A read-only,
  git-powered review surface: a changed-files list with status glyphs and
  side-by-side / unified diffs rendered with `@codemirror/merge`, syntax-
  highlighted, refreshing while open. Multi-repo sessions get a repo dropdown;
  every git call runs with a hard timeout and no console flash. "Open in editor"
  jumps any file into an editable tab.
- **The editor opens any file, not just Markdown.** Open code from the drawer,
  tree, or `Ctrl+O` into syntax-highlighted, editable tabs (languages load
  lazily, off first paint). The agent-safety loop closes inside Lume: when an
  agent rewrites a file you have open, a clean tab silently reloads and a dirty
  tab raises a **"Changed on disk — Reload / Keep mine"** bar rather than
  silently losing your edits. Binaries are refused; files over 10 MB are never
  read.
- **Session resume across restarts.** A pane that was running an agent when
  Lume closed shows a slim **`✻ Claude was running here — Resume / Just shell`**
  banner on the next launch; Resume drops you back into the exact conversation
  (`claude --resume <id>`, or `--continue` when the id can't be trusted).
  Settings → Agents → "Auto-resume agents on restore" (default OFF) stands the
  whole fleet back up unattended.
- **Pane zoom — `Ctrl+Alt+Z` or the corner button.** Temporarily fill the
  session with one pane and press again to restore the exact grid. Pure CSS
  occlusion — no terminal ever unmounts — and zoom follows focus, so any focus
  move, split, close, or session switch brings the grid back (tmux `prefix z`).
- **Branch switcher in the status bar.** The `⎇ branch` display is now a real
  control: click it to see every branch (locals, then remotes, type-to-filter,
  current marked, "open" tag on branches a worktree already has) and selecting
  one takes you to a terminal ON that branch — jumping to its existing session,
  or checking it out into its own worktree (`~\lume\worktrees\<repo>\<slug>`)
  and opening a session there. Remote-only branches get a local tracking
  branch. Never an in-place `git checkout`: the files under a running agent
  are never touched, and git's one-branch-one-worktree rule keeps two
  terminals from ever writing to the same branch.
- **Terminal credibility floor (Plan 012).** Three daily-driver basics, each an The `⎇ branch` display is now a real
  control: click it to see every branch (locals, then remotes, type-to-filter,
  current marked, "open" tag on branches a worktree already has) and selecting
  one takes you to a terminal ON that branch — jumping to its existing session,
  or checking it out into its own worktree (`~\lume\worktrees\<repo>\<slug>`)
  and opening a session there. Remote-only branches get a local tracking
  branch. Never an in-place `git checkout`: the files under a running agent
  are never touched, and git's one-branch-one-worktree rule keeps two
  terminals from ever writing to the same branch.
- **Terminal credibility floor (Plan 012).** Three daily-driver basics, each an
  independently revertable change:
  - **Scrollback search — `Ctrl+F`.** A slim overlay bar (top-right, below the
    pane's corner cluster) searches the focused terminal's scrollback:
    incremental, case-insensitive, `Enter` / `Shift+Enter` to step matches, a
    live `3/17` counter, `Esc` to close and return focus. Opens only when a
    terminal is focused — the MD editor keeps CodeMirror's own find.
  - **Ctrl+click web links.** `Ctrl`/`Cmd`+click an `http(s)` URL in output to
    open it in your default browser. A plain click stays with the shell's mouse
    modes so agents and TUIs keep their clicks.
  - **Multiline-paste guard.** Pasting text that contains a line break asks
    first — most shells run each completed line the instant it's pasted.
    Confirm pastes the text unchanged; cancel sends nothing. Single-line pastes
    never prompt. Toggle in Settings → Terminal → "Warn on multiline paste"
    (default ON).
- **Land an attempt from the Diff tab (Plan 013 Phase B).** Attempt sessions
  (worktrees forked via "New attempt") gain a **Land…** menu in the Diff header
  that offers only the paths that apply: **Create pull request** (`gh pr create
  --fill` in the worktree, success toast links the PR) when a remote and the
  GitHub CLI are both present; **Open compare page** as the GitHub fallback when
  `gh` is absent; and **Merge into `<base>` locally** — enabled only when the
  main checkout is provably safe (on the base branch AND clean), otherwise shown
  disabled with the exact reason inline. The merge command re-verifies that
  safety at the instant of merge and aborts any conflict, so the main checkout
  is never left mid-merge. **Clean up…** (offered after a local land, and as its
  own flow) removes the worktree and deletes the branch behind a confirm —
  refusing a dirty worktree (`worktree remove`, no `--force`) or an unmerged
  branch (`branch -d`, never `-D`) with git's own words. Nothing is ever forced,
  stashed, or guessed.
- **Merge-base diffs for attempt sessions (Plan 013 Phase B).** The Diff tab now
  defaults an attempt to diffing against `merge-base(HEAD, <baseBranch>)` — i.e.
  *everything the attempt changed since it forked*, not just uncommitted work —
  with a header toggle back to **vs HEAD**. Non-attempt sessions are unchanged
  (HEAD-only).
- **OS attention escape (Plan 011).** Plan 008's precise agent signals now
  reach you when Lume is minimized or in the background. When a Claude Code
  agent is **blocked on a permission prompt**, Lume raises a system toast
  (`⏸ Claude needs permission`, with the session name), flashes the taskbar
  button once (focus-preserving), and shows a **taskbar overlay badge** with the
  fleet's needs-you count. A completed turn (**your move**) updates the badge
  only — opt into a toast for it with Settings → Agents → "Toast on turn
  complete" (default OFF).
- **Two new Settings → Agents toggles.** "OS notifications" (default ON) is the
  master switch for the whole escape surface — off keeps every signal in-app and
  clears the badge. "Toast on turn complete" (default OFF) upgrades the calmer
  your-move tier to a toast.

### Changed
- The taskbar badge and the status-bar needs-you chip now derive from a single
  shared `needsYouCounts` selector, so they can never disagree about how many
  sessions need you. The badge always mirrors the current count; toasts and the
  flash are edge-triggered (fire on *entering* a phase), suppressed when the
  window is focused and the session is on-screen, and throttled by a 3 s global
  min-gap. Only deterministic class-A signals ever escape — output heuristics
  never do. All native attention calls are best-effort no-ops on failure.

### Performance
- **Every git, `gh`, and file-I/O command now runs off the main thread.** Tauri
  v2 runs synchronous commands on the UI thread, so a slow `git` (the branch
  poller fires one every 5 s) or a cloud-only OneDrive file hydrating on first
  read could block the whole IPC queue — including each keystroke — and the
  terminal would freeze, then flood back. All 17 git/gh commands and the four
  file-I/O commands now hop onto the blocking pool via `spawn_blocking`;
  keystrokes (`pty_write`) stay on the fast path. No more freeze-then-catch-up.

### Fixed
- Resume only trusts a session id once real conversation content proves it
  exists on disk, so an empty session can never leave a "No conversation found"
  id — and never clobbers the previous real conversation's id.
- Cleanup stops an attempt's session before removing its worktree (an open cwd
  locks the directory on Windows), with a brief retry for async PTY teardown.
- The multiline-paste guard covers every paste path, including drag-dropped
  file paths.
- The status bar keeps the session label and branch chip together at the
  bottom-left, and shows the active session even before a pane is clicked.

## [0.1.0-beta.10] — 2026-07-02

Lume learns exactly what your agents are doing.

### Added
- **Precise Claude Code signals (opt-in).** A new Settings → Agents toggle
  installs Claude Code lifecycle hooks into `~/.claude/settings.json` so Lume
  knows each agent's *exact* state per pane — working, blocked on a permission
  prompt, or turn-complete/your-move — instead of guessing from output
  cadence. The merge is additive (your existing hooks and settings are
  preserved), atomic, and fully reversible from the same toggle; a canary
  warning surfaces if the hooks are installed but never fire (older Claude Code
  versions). Panes are tagged with `LUME_PANE_ID` at spawn (crossing the
  Win32→WSL boundary via `WSLENV`), and a tiny shim spools each hook event to
  `%APPDATA%\lume\agent-events` for a Rust watcher to read.
- **Sidebar signals got precise.** A background session now shows a hollow
  accent ring with a glow pulse when its agent is *waiting on your permission*,
  a solid accent dot with a steady glow when it's *your move* (turn complete),
  the tumbling square while *working*, and a hollow grey dot when idle —
  ranked `permission > your-move > working > idle`. An agent-identity glyph
  (Claude `✻`, Codex `▌`, Gemini `✦`) sits after the session name when the
  pane is known to host that agent.
- **Multi-agent identity via launch-command detection.** Codex and Gemini
  panes are identified from the command line that started them, so Lume
  renders the right glyph and tint even before any hook event lands.
  Command-sourced identity never takes precedence over a hook-sourced one
  and never clobbers it; an agent finishing a command clears the
  command-sourced entry, not the hook-sourced one.
- **Codex gets a real glyph.** Codex ships a custom blossom SVG (the
  OpenAI mark) instead of the plain `>` character, so it reads at 11px
  next to the text glyphs. Tinted OpenAI green-teal, sized to match the
  other agent glyphs.
- **Nothing needing you stays hidden.** Collapsed folder headers inherit
  their most-urgent child's signal, and the status bar rolls up the
  blocked (`◎`) and your-move (`●`) counts across background sessions.
- **A Signals legend** in the `Ctrl+?` shortcuts modal, plus exact-reason
  tooltips and state-named row labels for screen readers.
- **Ranked fuzzy search in the file drawer.** Type in the drawer's filter
  and the tree is replaced by a ranked BFS over the workspace: exact
  match, name-prefix, name-substring, path-substring, then a
  fuzzy-compact fallback, sorted by score and depth. Generated and heavy
  folders (node_modules, .git, dist, target, …) are skipped; a result is
  opened with the OS handler, and activating one auto-expands its folder
  path in the tree.

### Fixed
- **Your-move calms on view.** A *your-move* signal that lands while its
  session is visible (or is later brought into view) transitions to idle
  — the agent-phase mirror of the existing `unread=false` on activate.
  Permission is exempt: still blocked is still urgent.
- **Permission exits on sustained output.** A permission-blocked pane is
  the one agent-owned pane that still listens to output (approving a
  prompt fires no hook event until Stop), so two output chunks within
  the sustain window demote it back to *working*. Fails toward the
  calmer state; the next exact event corrects.

### Performance
- **Status bar needs-you roll-up is memoized.** The bar subscribes to a
  wide pty slice for its other fields, but the roll-up only depends on
  the sessions / agent slices, so the count is computed once per change
  to those slices and reused for unrelated renders.

[0.1.0-beta.10]: https://github.com/rithwik1510/Lume/releases/tag/v0.1.0-beta.10

## [0.1.0-beta.9] — 2026-06-29

A real markdown editor and a terminal you can trust with the clipboard.

### Added
- **CodeMirror is now a real editor.** The MD Editor gets full keyboard
  muscle memory: search (Ctrl+F), fold (Ctrl+Shift+[ / ]), bracket-matching
  highlights, multi-cursor (Alt+Click), syntax highlighting, and a styled
  gutter with line numbers, active-line highlight, search-panel chrome, and
  a matching-bracket token. You can edit markdown like code.
- **MD Editor Save button + per-tab memory.** A save button (and Ctrl+S)
  writes the current tab. Each open tab remembers its own selection range
  and scroll position when you switch away and come back.
- **MD Tabs are accessible and keyboard-navigable.** Full a11y roles on the
  tab strip, arrow-key navigation between tabs, and a dirty-close confirm
  before discarding unsaved changes.
- **MD Preview learns the rest of markdown.** Relative `.md` links navigate
  inside the preview, heading anchors let you deep-link to a section,
  GitHub-style callouts (note, tip, warn, danger) render with the right
  color, task lists check off, and Windows UNC paths (`\\server\share\…`)
  resolve correctly.
- **Quick Viewer opens `.md` links from the terminal.** Ctrl+Click any
  `.md` path in a terminal session and it pops open in the Quick Viewer
  on the right — read the file the agent just wrote without losing the
  terminal you launched it from. A toast surfaces failures (path that
  doesn't resolve, file no longer on disk) so the open doesn't fail
  silently.
- **Sessions only light up when hidden.** When you're in a split view, the
  "needs you" unread indicator on a session only lights up for the
  sessions you can't currently see — a session that's already in front
  of you in the split no longer pulses. No more "is it new or did I just
  look at it?" guessing.
- **Terminal advertises truecolor and ships a 16-color theme.** xterm.js
  now tells apps it supports 24-bit color, and the bundled theme maps the
  standard 16 colors to the Lume palette so anything that uses them
  (prompt segments, ls --color, diff) looks right.

### Fixed
- **Terminal clipboard is now reliable.** Clipboard copy goes through a
  host plugin path, and OSC 52 (`\e]52;c;…\a`) is honored — programs
  that copy to clipboard through escape sequences actually copy.
- **Sidebar file tree refreshes on Windows.** The `\\?\` extended-length
  path prefix that some Windows APIs hand back was preventing the watcher
  from matching real paths; the prefix is stripped before comparison, so
  the tree updates when files change on disk.

[0.1.0-beta.9]: https://github.com/rithwik1510/Lume/releases/tag/v0.1.0-beta.9

## [0.1.0-beta.8] — 2026-06-25

Side-by-side splits you can name, leave, and come back to.

### Added
- **Split sessions stay paired.** When you drag one session beside another, the
  two now join into a durable group shown as a single bracketed pair in the
  sidebar — each keeping its own working / needs-you dot, so you still see at a
  glance which agent needs you. Jump to another session and come back: clicking
  the pair reopens the split right where you left it, and the pairing survives an
  app restart. The × on the seam separates them again (back to two standalone
  sessions); leaving by clicking another session keeps the pairing for later;
  right-click a member → **Ungroup split** to break it apart.

[0.1.0-beta.8]: https://github.com/rithwik1510/Lume/releases/tag/v0.1.0-beta.8

## [0.1.0-beta.7] — 2026-06-20

Smooth with a fleet of sessions open.

### Performance
- **Off-screen sessions no longer render in real time.** Every session you have
  open kept parsing its output into the renderer even when you couldn't see it,
  so a fleet of 6-7+ sessions under heavy output could saturate the UI and
  freeze. Now only the session(s) on screen render live; background sessions
  keep running and replay instantly the moment you switch back. The app's cost
  is bounded by what's on screen, not by how many sessions you've opened.
- **WebGL terminal contexts are pooled and capped.** Many open sessions can no
  longer exhaust the GPU's context limit and drop terminals to slow rendering.

## [0.1.0-beta.6] — 2026-06-19

View two sessions side-by-side.

### Added
- **Drag a session onto the screen to split it.** Grab any session from the
  sidebar and drop it on the terminal area — it docks beside the one you're in,
  so you can watch two projects (or two agents in different folders) at once. A
  "Drop to split" hint shows where it'll land; the seam between them drags to
  rebalance, clicking either side hands it the keyboard, and the × on the seam
  collapses back to one. The dragged-in session revives the same way clicking it
  does, and nothing is torn down when you close the split — it just goes back to
  being a background session. Split view replaces the Quick Viewer / Preview /
  Markdown editor while it's open (and they replace it), and it's a transient
  view — a fresh launch always opens single.

[0.1.0-beta.6]: https://github.com/rithwik1510/Workflow/releases/tag/v0.1.0-beta.6

## [0.1.0-beta.5] — 2026-06-10

Your agents come back when you reopen Lume, plus attention-signal polish.

### Added
- **Restored sessions relaunch their agent.** When Lume reopens a session (on
  launch or when you click a stopped one), the command you last ran in each
  pane is re-run automatically — so closing Lume mid-`claude` and reopening
  brings the agent back, not just an empty prompt. The command is typed only
  once the shell reports it's ready for input (via OSC 133), which is what made
  this safe to turn back on after the earlier prompt-freeze. Shells without
  shell integration (cmd, WSL) revive to a plain prompt.
- **Command memory tracks your latest launch.** Each pane remembers the most
  recent command you ran at its prompt (replacing the old "first command ever"
  behavior). Answers you type *into* a running agent are never mistaken for a
  launch command, so restore re-runs the right thing.
- **Animated logo loader.** The "working" indicator is now the Lume mark — the
  accent square tumbling clockwise inside the logo box — replacing the generic
  spinning ring. Its square shape also distinguishes "working" from the dot
  states at a glance.

### Changed
- **Legacy "New session" rows are renamed on launch.** Sessions saved before
  sequential naming shipped now become `Session 1`, `Session 2`, … per folder
  the moment the app loads, with a subtle slide-in as the new name appears.
- **Larger +/delete buttons** on session rows and folder headers — easier to
  see and to hit.

### Fixed
- **An idle agent no longer shows a phantom "working" loader.** An open-but-idle
  TUI (e.g. `claude` waiting at its input box) periodically repaints its status
  line; each repaint used to flip the spinner back on and wipe the needs-you
  dot, so quiet agents looked permanently busy. Working now requires a sustained
  output stream, so an idle agent settles into a steady dot and stays there.

[0.1.0-beta.5]: https://github.com/rithwik1510/Workflow/releases/tag/v0.1.0-beta.5

## [0.1.0-beta.4] — 2026-06-10

Attention system rebuilt, session restore returns, plus naming and terminal polish.

### Added
- **Shell integration (OSC 133) for accurate agent attention.** Lume now injects
  a small FinalTerm script into PowerShell-family shells so the shell itself
  reports when a command starts and finishes. The sidebar shows two honest
  signals per background session: a **spinning ring** while an agent/command is
  actively working, and an **accent dot** the moment its turn finishes or it
  blocks for your input. This replaces the old output-silence guess that could
  light up while an agent was still busy.
- **Session restore on launch is back — and reopens the whole fleet.** Every
  session that was running when you last closed Lume revives on startup with its
  terminals, layout, shell, and folder; the session you were last in is focused.
  (Processes themselves can't survive a restart — the workspace comes back, not
  live agents.)
- **Sequential session names.** New sessions are named `Session 1`, `Session 2`,
  … per folder instead of all reading "New session".

### Fixed
- **No more phantom attention signals.** Switching away from a session, leaving an
  idle agent, or resizing the window no longer fakes "working"/"done" cues. The
  repaints a background terminal emits during a switch or resize are filtered, so
  the signals reflect only real activity that happens after you leave.
- **Terminal no longer flickers or clips its prompt on session switch.** Hidden
  panes (a backgrounded session) reported a 0×0 size and were being resized to a
  degenerate grid, which rewrapped the shell's lines and left the prompt clipped.
  Hidden/zero-size and no-op resizes are now skipped.

[0.1.0-beta.4]: https://github.com/rithwik1510/Workflow/releases/tag/v0.1.0-beta.4

## [0.1.0-beta.3] — 2026-06-08

Bug-fix release.

### Fixed
- **Markdown editor was blank and uneditable in the packaged app.** The viewer
  worked, but switching to edit mode (pencil) showed an unstyled gutter and no
  visible/editable content. Cause: CodeMirror styles itself by injecting
  `<style>` elements at runtime (style-mod). In a production Tauri build, Tauri's
  default CSP handling adds a `'nonce-…'` to `style-src`, and per the CSP3 spec a
  nonce makes the browser ignore `'unsafe-inline'` — so CodeMirror's nonce-less
  injected styles were blocked (`style-src-elem blocked=inline`), leaving the
  editor with no theme or layout. Dev builds were unaffected (the nonce is only
  injected in production). Fixed by setting
  `dangerousDisableAssetCspModification: ["style-src"]` so our intended
  `style-src 'self' 'unsafe-inline'` stays effective; `script-src` keeps its
  nonce. This also unblocks any other runtime-injected styles (e.g. xterm).

[0.1.0-beta.3]: https://github.com/rithwik1510/Workflow/releases/tag/v0.1.0-beta.3

## [0.1.0-beta.2] — 2026-06-06

Bug-fix release.

### Fixed
- **Windows console-window flicker / launch freeze.** Background `git` branch
  lookups (and WSL shell detection) spawned subprocesses without
  `CREATE_NO_WINDOW`, so Windows flashed a black console window on every call —
  every ~5 s per active session and on each window focus. This presented as
  whole-window flicker, and on launch with a restored session the rapid
  focus-stealing froze the window. Both spawns now run with no console window.
- **Session restore no longer auto-types the remembered command** into the
  revived shell — replaying it raced PowerShell's line editor and could garble
  or freeze the prompt. The command is still remembered on the pane.

### Changed
- Reopen-last-session-on-launch is temporarily disabled: launch starts with all
  sessions stopped (click a session in the sidebar to revive it). Returns in a
  later build once re-verified against the fixes above.

[0.1.0-beta.2]: https://github.com/rithwik1510/Workflow/releases/tag/v0.1.0-beta.2

## [0.1.0-beta.1] — 2026-06-03

First public beta. Windows only.

### Added
- Smooth tiled terminal panes (xterm.js + WebGL) backed by real PTYs with
  32 ms batched IPC and an 8 MB per-pane ring buffer.
- Session manager sidebar — grouped sessions, rename, attention glow when a
  background agent goes quiet.
- Session restore — reopen the last session on launch and pre-fill each pane's
  remembered first command at the prompt (never auto-run).
- Markdown editor (CodeMirror 6 / view-mode render) + MD Quick Viewer.
- Localhost Preview panel — iframe a dev server beside your terminals.
- Drag a file from Explorer or the file drawer onto a terminal.
- Settings UI with theme + font-pair presets; hot-reloaded `config.toml`.
- Toasts, confirm dialogs, split menu, keyboard-shortcuts viewer.
- In-app auto-update (Tauri updater).

### Known limitations
- Windows only this beta; macOS/Linux later.
- Installer is unsigned — Windows SmartScreen shows a warning (see README).
- PTYs do not survive restart; sessions revive layout + pre-filled commands,
  not live processes.

[0.1.0-beta.1]: https://github.com/rithwik1510/Workflow/releases/tag/v0.1.0-beta.1

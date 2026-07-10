# Lume

A desktop app that combines smooth multi-terminal tiling, a file sidebar, and a markdown editor into one workspace, so a developer can run AI coding agents and edit notes/plans without leaving the app.

## Language

**Lume**:
The product itself. The combination of smooth tiled terminal panes, a file sidebar, and a markdown editor in one window — the "whole shebang." One running instance is one Lume.
_Avoid_: App, program, IDE, terminal, tool.

**Pane**:
A rectangular cell inside the Lume's tiling area that holds one piece of content. Has a stable identity (Pane ID), a size, and a position in the Layout tree. Does not include the Sidebar.
_Avoid_: Tile, cell, widget, frame, view.

**Pane Content**:
What is currently mounted inside a Pane. Each Pane has exactly one Pane Content at a time. v0.1 content types: `Terminal`. v0.1.1 adds: `Dashboard`. Markdown editing is NOT a Pane Content type — it lives outside the Tiling Area (see MD Editor and MD Quick Viewer).
_Avoid_: Pane type (ambiguous — "type" can imply the Pane itself is typed).

**Terminal** (as Pane Content):
A live PTY session rendered by xterm.js with the WebGL renderer. Each Terminal owns one shell process. Closing the Pane terminates the shell.
_Avoid_: Console, shell pane, term.

**Shell**:
The OS-level program that backs a Terminal. v0.1 auto-detects on launch and supports: `pwsh.exe`, `powershell.exe`, `cmd.exe`, each installed WSL distro (e.g., "Ubuntu", "Debian"), and `Git Bash`. The detected list is offered wherever a shell choice is needed (new Tab, split with shell choice, per-Pane "Change Shell..."). The Lume's `default_shell` (in `config.toml`) is used for any "+ / split" action without an explicit choice.
_Avoid_: Interpreter, command line.

**Split Direction**:
The direction in which a Split places the new Pane relative to the focused Pane. v0.1 exposes three directions in the UI: `right` (new Pane on the right), `top` (new Pane above), `down` (new Pane below). The Layout data model supports `left` as well, but no UI affordance ships in v0.1.
_Avoid_: Orientation, axis, position.

**Tiling Area**:
The main area of the Lume that contains all Panes. Sits between the Sidebar (left) and the optional MD Quick Viewer (right). When the MD Editor is in Full View, the Tiling Area is hidden.
_Avoid_: Grid, workspace, main pane, central area.

**MD Editor** (Full View):
A dedicated top-level mode of the Lume, distinct from the Tiling Area. Each open file lives in an **MD Editor Tab**. The body shows ONE pane at a time, in one of two modes:
- **View mode** (default): the tab's markdown rendered to HTML via `markdown-it` (linkify on) and sanitized through DOMPurify before injection (DESIGN.md §4 #10). Inter 15px sans-serif body, JetBrains Mono for fenced code blocks. Read-only — clicks don't edit.
- **Edit mode**: CodeMirror 6 source editor with markdown syntax highlighting and line numbers ON.

A **pen icon (`✎`)** in the top-right MD Editor toolbar toggles between modes. The icon is outlined in view mode and amber/filled in edit mode. Tab switches reset the mode to view. Supports multiple files open simultaneously via tabs along the top. Has its own file picker (Ctrl+O — opens an OS file dialog so any file on disk can be opened, not just files in the Sidebar). Entered/exited via a top-left button or Ctrl+E. While in MD Editor mode, terminals continue running in the background but the Tiling Area is not visible. The early v0.1 side-by-side editor+preview layout was replaced with this single-pane toggle (height mismatch + disorienting scroll sync); the single-pane toggle reads as one document with two viewing modes, like Obsidian or Bear.
_Avoid_: MD pane, editor view, document mode, notes mode.

**MD Editor View Mode** (replaces the earlier "MD Preview Pane" concept):
The rendered-HTML mode of an MD Editor Tab. Renders the tab's markdown via `markdown-it` with linkify enabled, sanitized through DOMPurify before injection. Headings, lists, code blocks (with syntax-highlighted nested language), tables, blockquotes, and links all render as HTML. Read-only — there is no inline editing in view mode; users switch to **edit mode** via the pen icon. Default mode for every newly-opened MD Editor Tab.
_Avoid_: Preview pane (the side-by-side concept is gone), reading view, output pane, MD Quick Viewer (separate surface — see below).

**MD Editor Tab**:
One file open in the MD Editor. Tabs display the file name and a `●` if there are unsaved changes. Ctrl+Tab cycles tabs. Ctrl+W closes the focused tab (v0.1: silently discards unsaved changes with a small toast warning; v0.2 will add an unsaved-prompt).
_Avoid_: Document tab, MD tab, file tab.

**MD Editor Tab Strip**:
The horizontal strip at the TOP of the MD Editor area (NOT spanning the Sidebar). One chip per open MD Editor Tab. Active Tab has the accent color as a 2px top border and a slightly brighter background. Inactive tabs are dimmer. Each tab auto-sizes to its file name (min ~80px, max ~200px, ellipsized past max). Close X on each tab visible on hover; always visible on the active tab.
_Avoid_: Editor tabs, document strip, file bar.

**MD Quick Viewer**:
A right-side resizable Panel (not a fixed-width drawer) that opens alongside the Tiling Area. Default width 25% of the Lume; resizable via a Splitter (sub-pixel smooth) between Tiling Area and Quick Viewer. Min width 250px, max width 60%. **Read-only rendered HTML** (markdown-it + DOMPurify, same pipeline as MD Editor view mode) bound to one markdown file. Designed for glancing at files an agent just wrote — terminals stay visible and running on the left while the file is open on the right. Closed by default on launch; opened by Ctrl+Click on an MD Link in a Terminal, by clicking an `.md` file in the Sidebar, by the Quick Viewer toggle icon in the top bar, or by Ctrl+Shift+M. The header carries two icons: a **pencil (`✎`)** that opens the file in the MD Editor Full View as a tab (for sustained editing), and a close (`✕`). There is no editing surface inside the Quick Viewer itself — all editing happens in the MD Editor Full View, so the model stays "one editing surface, one file open at a time" without sync risk.
_Avoid_: Drawer (it's a resizable Panel, not an overlay), side panel, preview pane, peek view, sidebar (the left Sidebar is separate), editor (Quick Viewer cannot edit — it dispatches to the MD Editor).

**MD Link** (in Terminal Pane):
Any text rendered inside a Terminal Pane that parses as a file path, ends in `.md`, and resolves to an existing file. xterm.js renders it as an underlined-on-hover, accent-colored link. **Ctrl+Click opens the file in the MD Quick Viewer.** Relative paths resolve against the Terminal Pane's current working directory (v0.1 limitation — v0.2 adds OSC 7 shell integration for per-line cwd tracking).
_Avoid_: Hyperlink, file link, markdown hyperlink.

**Sidebar**:
The fixed left-side surface that holds the file tree, rooted at the current Workspace Folder. Toggleable visibility but not part of the Layout tree — cannot be split, focused as a pane, or tiled. Clicking a folder in the Sidebar expands/collapses the tree only; it does NOT change any Terminal Pane's cwd and does NOT change the Workspace Folder. Header has two action icons in v0.1: 🔍 Filter (type to filter visible files by name) and ➕ New file (creates a new `.md` file in the focused folder and opens it in MD Editor Full View). ↻ Refresh is not in v0.1 — the file watcher auto-refreshes the tree when the Workspace Folder changes on disk.
_Avoid_: File panel, drawer, navigator, explorer pane.

**Status Bar**:
The 24px-tall bar at the bottom of the Lume. Background `bg.1`, single 1px top border, JetBrains Mono 12px in `fg.1` color. Two segments:
- **LEFT** (auto-changes with focus): a focused-element summary. Terminal Pane focused → `[shell] · [pane cwd]`. MD Editor tab focused → `[file name] · Ln N, Col M` (with selection count appended when text is selected). Quick Viewer focused → same as MD Editor tab. Sidebar focused → Workspace Folder path.
- **RIGHT** (always): `[workspace short name]` + active-process indicator `⏵ N` if any Terminal Panes have active child processes (the dot uses accent color; omitted when N=0). Click on the indicator in v0.3+ jumps to the Dashboard; in v0.1 it is informational only.
_Avoid_: Footer, info bar, bottom bar.

**Workspace Folder**:
The stable folder anchor for the Lume. The Sidebar's file tree is rooted at it. New Terminal Panes spawned with no other context inherit this as their cwd. Existing Terminal Panes are never auto-`cd`'d when the Workspace Folder changes — each shell tracks its own pwd. Persists across restarts. On first launch, defaults to the user's home directory. Changed by the user explicitly via the top-bar "Open Folder" button or Ctrl+K Ctrl+O.
_Avoid_: Project, root, workspace, working directory (the term "working directory" is reserved for a Terminal's own pwd).

**Layout**:
The binary tree of Panes inside the Tiling Area. Internal nodes are vertical or horizontal splits; leaves are Panes. Persists across restarts.
_Avoid_: Grid, arrangement, workspace, layout tree.

**Split**:
The act of dividing one Pane into two by inserting a vertical or horizontal split node into the Layout. The new Pane defaults to Terminal content. The new Terminal's cwd inherits from the focused Pane's *current shell pwd* if the focused Pane was a Terminal; otherwise it inherits from the Workspace Folder.
_Avoid_: Divide, partition, fork.

**Splitter**:
The draggable handle between two Panes (or between an internal split node and its sibling) that lets the user resize the panes on either side. Drag is sub-pixel smooth, no snap-to-grid. Minimum pane size is ~100px (below which the splitter stops resisting). Resize updates the Layout tree's split ratio in real time; running terminals reflow their cols/rows immediately. Panes themselves cannot be drag-and-dropped to new positions in v0.1.
_Avoid_: Divider, gutter, handle, separator.

**Tab** (v0.2+):
A complete, switchable Workspace within the Lume. Each Tab owns its own Workspace Folder, Sidebar expand state, Layout tree, and set of Panes (with their PTYs). Switching Tabs swaps which Tab is visible; the inactive Tabs keep their PTYs running in the background. Tab label auto-derives from the Workspace Folder name and can be renamed by the user (right-click → Rename). Tabs are independent: closing one does not affect the others. **Not in v0.1** — v0.1 ships with one Workspace Folder open at a time, no Tab Strip in the UI.
_Avoid_: Window (Lume has one Window; Tabs are inside it), session, project.

**Tab Strip** (v0.2+):
The horizontal strip across the top of the Lume that displays one chip per open Tab, plus a "+" button to create a new Tab. Active Tab is highlighted. Click a chip to switch. Click X on a chip to close (with confirm if any of that Tab's Panes have active child processes). **Not in v0.1.**
_Avoid_: Tab bar, navigation, header.

**Agent Session** (hook-tracked):
The run of a coding agent (Claude Code in v0.1) inside one Terminal Pane, tracked exactly via agent hooks. When **Precise Claude Code signals** is enabled (Settings → Agents), Lume installs Claude Code hooks into `~/.claude/settings.json`; a `claude` launched in a Lume Terminal then announces every lifecycle transition — SessionStart, UserPromptSubmit, Notification (permission / idle), Stop, SessionEnd, plus SubagentStart / SubagentStop — tagged with the pane it runs in (via the `LUME_PANE_ID` env var). Lume turns those into the pane's exact **agent state**: working, waiting on permission, turn complete / your move, or gone. Background subagents matter because the main agent's `Stop` fires when ITS turn ends even while background subagents keep running; Lume counts live subagents per pane and holds the state at **working** until the last one reports done, so a session never shows "your move" while work is still happening. This is deterministic ground truth (the "class A" signal): it outranks the OSC 133 command lifecycle and the output-cadence guess, which remain the fallback for shells and agents without hooks.
_Avoid_: Chat, conversation, thread (an Agent Session is the agent's run inside a pane, not its transcript).

**Session Signal** (sidebar indicator):
The single indicator a session row shows for a *background* session, ranked most-urgent first: **waiting on permission** (hollow accent ring with a glow pulse — an open question waiting for YOU to answer), **your move** (solid accent dot with a steady glow — a finished turn / the agent is waiting at its prompt; Stop and idle notifications collapse here), **working** (the tumbling logo square — a turn is in progress), and **idle** (hollow grey dot — open, nothing running). The session you're viewing never signals (you can see the terminal). Priority is `permission > your-move > working > idle`. A collapsed folder header inherits its most-urgent child's signal, and the Status Bar rolls up the blocked (`◎`) + your-move (`●`) counts across background sessions. The full legend lives in the Ctrl+? shortcuts modal. An agent-identity glyph (Claude `✻`) sits after the session name once the agent is known.
_Avoid_: Badge, notification, alert (the signal is state, not an event); "status dot" (ambiguous with the process indicator).

**Tip** (Workflow coach):
One piece of learnable Lume advice managed by the coach — a rescue for a live failure or repeated friction. A Tip lives in one of two lanes: **push** (a live **Coach Chip** anchored to the pane or the session pair, the interrupt lane) or **shelf** (a **For you** row in Shortcuts & tips, the pull lane, zero interruption). Every push obeys one global ceiling: at most one a day, two in any trailing 7 days, two showings per Tip ever, no exemptions. A Tip is never feature marketing — it fires only for an active failure or high-confidence, anchorable friction.
_Avoid_: Hint (the AttemptHintChip is a separate one-shot), notification, nag, suggestion popup, Clippy.

**Shelf** (the "For you" section):
The pull lane — a group in the **Shortcuts & tips** modal (Ctrl+?) that holds Tips which don't warrant an interruption (enable precise Claude signals, Ctrl+F to search scrollback), plus the durable copy of a push Tip after it has fired. A Tip earns a Shelf row while it is shelved, not graduated, and not dismissed. A newly shelved Tip lights a 2px dot on the ⌨ icon (at most once per 7 days), cleared when the modal opens. The Shelf costs zero attention, so it can hold looser thresholds than the push lane.
_Avoid_: Inbox, notification center, tips panel, drawer, feed.

**Graduation** (earned silence):
The retirement of a Tip because the user performed the taught action — a successful Shift-drag selection, a drag-to-split, opening Ctrl+F search, or a hook event proving precise signals already work. Graduation is permanent and can be **retroactive**: an existing durable split group or a Ctrl+F user retires the matching Tip before it ever fires. A graduated Tip records nothing further and never pushes or shelves again. Distinct from **dismissal** ("Don't suggest this"), which is the user rejecting the Tip and also opens a 7-day global quiet on every push.
_Avoid_: Dismissal (that is user rejection, not a learned action), completion, done, snooze, mute.

## Lume surfaces (top-level UI structure)

```
+----------------------------------------------------------------------+
| [☰ Sidebar] [⊞ Split] [⌨ Keys]  | posan + |    🔍 search    [⚙][_][□][x]
+---------+----------------------------------------+------------------+
|         |                                        |                  |
| Sidebar |          Tiling Area                   | MD Quick Viewer  |
| (file   |          (Terminal Panes)              | (optional,       |
|  tree)  |                                        |  ~25% width)     |
|         |                                        |                  |
|         |                                        |                  |
+---------+----------------------------------------+------------------+
| pwsh · C:\Users\posan                                                |   ← Status Bar
+----------------------------------------------------------------------+
```

Top bar elements (left to right):
- **☰ Sidebar toggle** — show/hide the Sidebar.
- **⊞ Split menu** — popup with three split-direction icons (→ right, ↓ down, ↑ up). No `left` direction in v0.1.
- **⌨ Keyboard shortcuts viewer** — popup listing all current shortcuts, read-only in v0.1.
- (v0.2+) **Tab Strip** — open Tabs with the active Tab highlighted, plus a "+" button to create a new Tab. Not present in v0.1.
- (v0.3+) **▦ Dashboard icon** — toggle Dashboard view. Not present in v0.1 or v0.2.
- (v0.3+) **Spotlight search** — invoked by Ctrl+K, no top-bar element; opens as a modal. Not present in v0.1 or v0.2.
- **📄 Quick Viewer toggle** — small icon on the right side of the top bar. Click → opens the Quick Viewer with the most-recently-viewed file (or an empty placeholder if never opened). Click again → closes the Quick Viewer. Also bound to Ctrl+Shift+M.
- **🗎 MD Editor mode toggle** — top-left icon (next to the Keyboard shortcuts viewer). Click → switch to MD Editor Full View. Also bound to Ctrl+E.
- **⚙ Settings gear** — opens `config.toml` in a new MD Editor tab (with TOML syntax highlighting). v0.1 has no separate settings UI; the file IS the settings UI.
- **Window controls** — minimize / maximize / close (native to the OS window manager).

When the MD Editor is in Full View, the Tiling Area + MD Quick Viewer area are replaced by a single full-width CodeMirror 6 editor with the open MD Tabs across the top. The Sidebar remains visible.

## Theme

**Theme** in v0.1 is a fixed pair: brutalist-minimalist layout + the "Amber on Black" palette (color tokens locked in DESIGN.md). v0.2 introduces 5 accent presets (the `accent` family swaps; everything else stays). Backgrounds are always near-black; the app is intentionally not light-mode-capable in v0.1.

## Typography

Layered, not monolithic:
- **Inter** for UI (top bar, status bar, sidebar, tab strips, toasts, buttons) and for MD Editor body prose.
- **JetBrains Mono** for terminal pane content, MD Editor code blocks (` ``` ` fenced), and any `.toml`/code-like file opened in the MD Editor.

Inter is bundled as woff2 inside the binary (~150KB). JetBrains Mono is bundled the same way. Both have system fallbacks.

## Frameless titlebar

**v0.1 ships a custom HTML titlebar** (Tauri window `decorations: false`). 36px tall, `bg.0` background, 1px `border` bottom. Drag region via `data-tauri-drag-region`. Minimize / maximize / close icons on the far right using Lucide icons. The titlebar is the same surface that holds the Sidebar toggle, Split menu, Keyboard shortcuts viewer, MD Editor toggle, Quick Viewer toggle, and Settings gear. v0.2 adds Mica blur behind this same titlebar (no structural rework).

## Initial state (on launch)

A fresh Lume opens with: Sidebar visible, one Pane filling the Tiling Area, Pane Content set to Terminal with the user's home directory as the working directory. MD Quick Viewer closed. MD Editor toggle in the "off" state (Tiling Area visible, not the editor).

## Lume invariants

These hold at all times:

1. **The Layout always has at least one Pane.** Closing the last Pane is not allowed; the close affordance is disabled when only one Pane remains, and Ctrl+W on the focused last Pane is a no-op with a subtle toast.
2. **A Pane always has exactly one Pane Content mounted.** Empty Panes do not exist.
3. **Closing a Terminal Pane with an active child process** (anything beyond an idle shell — e.g., a running Claude Code session, a build, a long task) **shows a confirm dialog** before terminating the PTY. Closing an idle-shell Terminal Pane is silent.
4. **The Workspace Folder is always set.** On first launch it defaults to the user's home directory; on subsequent launches it is restored from persisted state.
5. **PTYs do not survive Lume restart.** Each Pane re-spawns a fresh shell at its saved cwd when the Lume reopens. Running agents (Claude Code, builds, etc.) are NOT resumed — the Layout shape is restored, the live processes are not.

(v0.2 adds: the Lume always has at least one Tab; closing the last Tab is not allowed.)

## Flagged ambiguities

(Resolved as the grill session continues.)

## Example dialogue

> **Dev A:** Are you using the Lume for the auth refactor?
> **Dev B:** Yeah, three terminals on the right — Claude Code, Codex, and a build watcher. Plan is open in the MD pane on the left, file tree pinned to the auth folder.
> **Dev A:** Nice. Did you have to switch out to Sublime for the spec?
> **Dev B:** No, it's all in the Lume now. That's the point.

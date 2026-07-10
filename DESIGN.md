# Lume — Design Specification

**Status:** DRAFT (post-/grill-with-docs)
**Date:** 2026-05-21
**Working name:** TBD (candidates: Pier, Dock, Loft, Quay, Workbench, Helm)
**Project mode:** Open-source builder project, single developer
**Target platform:** Windows-first (v0.1); macOS + Linux land in v0.4+
**License:** MIT

For domain language, see [CONTEXT.md](CONTEXT.md). For architectural decisions, see [docs/adr/](docs/adr/). For strategic context, see [CEO-REVIEW.md](CEO-REVIEW.md).

---

## 1. Overview

A desktop app that combines smooth tiled terminal panes, a file Sidebar, and a markdown editor into one workspace. The goal is to host a developer's daily workflow — running AI coding agents (Claude Code, Codex) across multiple terminals while editing notes, plans, and specs in the same window — without the visual jank that breaks the spell in existing multi-pane terminals (Terax, Hyper, Tabby, Wave).

The differentiation isn't the renderer (every modern app uses xterm.js + WebGL or equivalent); it's the combination of:
1. A disciplined IPC architecture that keeps the UI responsive under heavy agent output.
2. Markdown as a first-class surface — both a full-screen mode (Ctrl+E) and a right-side Quick Viewer drawer for glancing at files agents just wrote.
3. A "workstation desk" metaphor — opinionated single aesthetic, curated tooling, intentional defaults.
4. (v0.3) An agent-aware Dashboard view showing every running pane across all Tabs.

---

## 2. Iteration plan

Build iteratively. Each version is daily-driveable before the next is started.

### v0.1 — Foundation (~6-8 weekends)
The smallest version that replaces the user's daily Sublime + Windows Terminal + ad-hoc workflow.

- Tiled Terminal Panes with smooth split (right/up/down) and splitter resize.
- MD Editor Full View (Ctrl+E) with simple multi-file tabs, defaulting to a rendered HTML view (markdown-it + DOMPurify); a pen icon in the top-right toolbar toggles to a CodeMirror source editor with line numbers ON.
- MD Quick Viewer (right Panel, ~25% width default, resizable) triggered by Sidebar click, MD Link Ctrl+Click in a terminal, top-bar icon, or Ctrl+Shift+M. **Read-only rendered view** (markdown-it + DOMPurify) — no editing surface. A pencil icon in the Quick Viewer header opens the file in the MD Editor Full View as a tab; that's the path for sustained editing. Single editing surface across the app keeps the model simple and removes any sync risk between two editing views of the same file.
- Sidebar with file tree rooted at the Workspace Folder.
- Shell auto-detection: pwsh, powershell.exe, cmd.exe, **all installed WSL distros**.
- Config file (`~/.lume/config.toml`) with hot reload via `notify`.
- "Amber on Black" theme (single locked palette).
- **Frameless custom titlebar** (Tauri `decorations: false`) — drag region + minimize/maximize/close. Mica blur deferred to v0.2.
- Layered typography: Inter for UI and MD body; JetBrains Mono for terminals and MD code blocks.
- Settings gear opens `config.toml` in an MD Editor tab.
- Status Bar showing focused-element info + workspace summary.
- Lume invariants: ≥1 Pane always; PTYs do not survive restart.
- **No Tabs in v0.1.** Single Workspace Folder, like Sublime Text's "Open Folder" model.

### v0.2 — Tabs + Mac polish (~3-4 weekends)
- Full multi-Tab (new, close, switch, persist, rename via right-click).
- Mac-native polish layer: **Mica blur** on the frameless titlebar (the titlebar itself ships in v0.1), spring-easing animations on splitter drag and pane focus transitions, refined fade timing on MD Editor toggle and Quick Viewer slide-in.
- **Pane scrollbar polish:** auto-hide overlay scrollbars per Terminal Pane, replacing xterm.js's default always-visible viewport scrollbar. Pattern: thin (6px), color-matched to `border` token, opacity 0 by default; opacity 1 on `:hover`, on active `scroll`, or for 1s after the wheel fires. CSS-only fix targeting `.xterm-viewport` + `.xterm-viewport::-webkit-scrollbar*`. Matches iTerm2 / Warp / Mac-native behavior. (Surfaced during Weekend 1 smoothness verification: default scrollbar visible on every pane is visually noisy vs reference apps.)
- MD Editor polish: unsaved-changes prompt, tab persistence, tab overflow UX.
- 5 accent presets (amber/blue/green/magenta/red) with hot-reload switching.
- Top-bar Split menu and Keyboard shortcuts viewer icons.
- Git Bash shell support.

### v0.3 — Spotlight + Dashboard (~3-4 weekends)
- Spotlight-style Ctrl+K modal — multi-source search (files, MD tabs, terminal scrollback, commands). Glass background.
- Dashboard view — every active Pane across Tabs as cards, click-to-jump. Top-level mode like MD Editor.
- Drag-to-reorder MD Editor tabs.

### v0.4+ — Deferred
- Pane drag-and-drop (swap, re-tile).
- "Recent MD files" list in Sidebar.
- OSC 7 shell integration.
- macOS DMG + Linux AppImage installers.
- GitHub Actions matrix CI.
- Code signing (Windows + macOS notarization).
- Plugin / theme system.

---

## 3. v0.1 surfaces and structure

```
+-------------------------------------------------------------------------+
| [☰] [⊞] [⌨]  [🗎 MD Editor]                       [📄] [⚙] [_][□][x]   |   ← Top Bar
+---------+----------------------------------------+--------------------+
| 🔍 ➕    |                                       |                    |
|         |                                       |                    |
| Sidebar |          Tiling Area                  | MD Quick Viewer    |
|  (file  |       (Terminal Panes only)           | (optional ~25%,    |
|  tree)  |                                       |  resizable Panel)  |
|         |                                       |                    |
+---------+---------------------------------------+--------------------+
| pwsh · ~/projects/auth                              posan · ⏵ 2     |   ← Status Bar
+-------------------------------------------------------------------------+
```

**Top Bar elements (left to right):**
- `☰` Sidebar toggle (Ctrl+B)
- `⊞` Split menu — popup with → right, ↑ up, ↓ down (no left direction)
- `⌨` Keyboard shortcuts viewer (Ctrl+?)
- `🗎` MD Editor mode toggle (Ctrl+E)
- (right side) `📄` Quick Viewer toggle (Ctrl+Shift+M)
- `⚙` Settings gear — opens `config.toml` in an MD Editor tab
- Native window controls

**Sidebar header:**
- `🔍` Filter — type to filter visible files by name
- `➕` New file — create new `.md` in focused folder, open in MD Editor Full View
- (no Refresh icon in v0.1 — file watcher auto-refreshes)

**Folder rendering:** folders whose names appear in `config.toml`'s `sidebar.collapsed_dirs` list (default: `node_modules`, `.git`, `__pycache__`, `target`, `dist`, `build`, `.venv`, `.next`, `.turbo`, `.cache`) render as collapsed by default. Children are NOT rendered until the user clicks to expand. Once expanded for the session, children render normally. This avoids the "Sidebar hangs because home folder contains a 5000-file node_modules" failure mode without needing tree virtualization. Virtualization can land in v0.2 if the lazy approach hurts. Other folders auto-expand at most one level deep on initial load to keep the tree readable.

**MD Editor Full View** replaces the Tiling Area + Quick Viewer area when active. The Sidebar remains visible. MD Editor Tab Strip sits at the top of the editor area (NOT spanning the Sidebar).

The body shows **one pane at a time** in one of two modes:
- **View mode** (default): rendered HTML via `markdown-it` + DOMPurify. Read-only.
- **Edit mode**: CodeMirror 6 source editor with markdown syntax highlighting + line numbers.

A **pen icon (`✎`)** sits in the top-right of the MD Editor toolbar. In view mode it's outlined; click → switch to edit mode and the icon goes amber/filled. Click again → back to view mode. Tab switches reset the mode to view. The early v0.1 side-by-side editor+preview layout (50/50 split, scroll-synced) was replaced with this single-pane toggle because the rendered-HTML height never matched the source height — the percentage-based scroll sync was disorienting and the duplicated content felt cluttered. The single-pane toggle reads as one document with two viewing modes, like Obsidian or Bear.

---

## 4. Frontend stack & state architecture

### Stack
- **Tauri v2** desktop shell (Rust host + WebView2 on Windows)
- **React 18 + Vite + TypeScript** front-end
- **Zustand** state library (see [ADR 0001](docs/adr/0001-frontend-stack.md))
- **xterm.js** + `@xterm/addon-webgl` + `@xterm/addon-fit` for Terminal Panes
- **CodeMirror 6** (vanilla, no React wrapper) for MD Editor Full View edit mode only; bundle `@codemirror/lang-markdown` + nested language support for ~10 common languages (js/ts, py, rust, go, bash, json, yaml, toml, html, css, sql). Quick Viewer is read-only rendered HTML — no CM instance there.
- **`markdown-it`** for the MD Editor's HTML Preview Pane. Locked config: `markdown-it({ html: false, linkify: true, breaks: true })` to prevent XSS via embedded HTML in markdown. `html: false` is non-negotiable — the Preview Pane renders inside the Tauri webview, which has Tauri command access. **DOMPurify** runs on markdown-it's output as defense-in-depth before injecting into the DOM. **Preview re-render is debounced to 250ms** after the last keystroke (avoids 50-100ms parse stalls on large docs). **Editor↔preview scroll sync uses `requestAnimationFrame`** to coalesce scroll events (a raw `scroll` event listener firing 60+Hz with `getBoundingClientRect` calls forces layout thrash).
- **`portable-pty`** (Rust crate) for PTY management
- **`notify`** (Rust crate) for config file watching
- **`toml`** (Rust crate) for config parsing
- **`dirs`** (Rust crate) for cross-platform config/data path resolution. All `~/.lume`-style paths in this spec resolve via `dirs::config_dir().join("lume")` on Rust side. Concretely on Windows that's `%APPDATA%\lume\` (Roaming) for config and `%LOCALAPPDATA%\lume\` for logs; macOS `~/Library/Application Support/lume/`; Linux `~/.config/lume/`.
- **`@tauri-apps/plugin-store`** (Tauri v2 official) — backing storage for Zustand's `persist` middleware. `localStorage` is webview-scoped and size-limited; the Tauri Store plugin writes to disk via Rust, atomically, in the platform config dir. Layout / Workspace Folder / Sidebar visibility / MD mode toggle persist there, not in localStorage.
- **`react-resizable-panels`** for split / splitter UI
- **`tauri-plugin-log`** + Rust `log` crate facade for logging. Front-end calls `log::info!(...)` style through a TS binding; logs are written to disk via the plugin in `dirs::data_local_dir().join("lume/logs")`.

### Error handling pattern (mandatory)
- **Rust side:** every Tauri command returns `Result<T, AppError>` where `AppError` is a single `thiserror`-derived enum. No `unwrap()` in production code paths. The Channel for PTY output uses `Result<Vec<u8>, AppError>` so front-end can render inline errors per pane.
- **Front-end side:** typed `AppError` discriminated union mirrors the Rust enum. A single top-level `ErrorBoundary` catches React render errors. Failures from Tauri commands flow into the toast system (§8) by default; specific cases (PTY spawn fail, save fail) override into inline-in-pane surfaces.

### Store slices (Zustand, day 1)
```
src/store/
├── ptyStore.ts          // pane metadata: { ptyId, shell, cwd, status, lastActivity }
├── layoutStore.ts        // binary tree, focusedPaneId, sidebarVisible, quickViewerOpen
├── settingsStore.ts      // mirror of config.toml (file-watched)
├── mdStore.ts            // MD Editor tabs, activeMdTabId, mdEditorMode
└── (v0.3) dashboardUiStore.ts   // hover, sort, filter
```

### Mandatory data-flow rules
1. **PTY bytes NEVER touch any Zustand store.** Flow: Rust portable-pty → batched bytes via **Tauri v2 `Channel<Vec<u8>>`** (NOT `app.emit`, which JSON-serializes payloads and defeats the architecture) → JS handler → `terminal.write(bytes)` directly into xterm.js. Stores only see metadata, never byte streams. The Channel is created per Pane on PTY spawn; the front-end registers a single handler that calls `terminal.write` synchronously on each chunk.
2. **xterm.js `Terminal` instances live in a module-level `Map<paneId, Terminal>`**, never in Zustand. Imperative and non-serializable. **PTY lifecycle is keyed by `paneId`, NOT by React component mount/unmount.** Weekend 0 spike caught this: React 18 StrictMode double-invokes effects in dev, and an open→kill→open ordering can resolve as open→open→kill, leaving the Rust PTY state in `None` and every keystroke erroring with "pty not open". The Map and the PTY spawn/teardown must be driven from the layout store (paneId added → spawn; paneId removed → kill), not from a React effect.
3. **DOM refs and non-serializable handles** live in `useRef` or module-level refs, never in Zustand.
4. **High-frequency metadata updates throttled to 200ms** per pane. `lastActivity` updated at most 5x/second.
5. **`zustand/middleware/immer`** wraps `layoutStore` for readable tree mutations.
6. **`zustand/middleware/persist`** for: layout tree shape, Workspace Folder, sidebar visibility, MD Editor mode toggle, settings. EXCLUDED: PTY metadata, focused pane id (resets on load), xterm.js instances, `lastActivity` timestamps.
7. **`zustand/middleware/devtools`** in dev mode; stripped in production.
8. **Selector hygiene:** atomic slices (one pane's metadata, not whole `panes` object); `useShallow` for array/object returns; derived state in selectors, never stored.
9. **PTY event listeners register once** on app mount (empty deps `useEffect`), read state via `getState()` in handlers.
10. **TypeScript discipline:** `types.ts` is the single source of truth for `Pane`, `LayoutNode`, `Shell`, `MdTab`, etc.

---

## 5. Theme — "Amber on Black" (v0.1)

| Token | Value | Use |
|---|---|---|
| `bg.0` | `#0a0a0a` | App background everywhere |
| `bg.1` | `#111111` | Active line, hover surfaces |
| `bg.2` | `#1a1a1a` | Code spans, Quick Viewer subtle differentiation, inactive tabs |
| `bg.3` | `#222222` | Selected/focused borders |
| `fg.0` | `#e6e6e6` | Body text |
| `fg.1` | `#9a9a9a` | Muted text, line numbers, status bar secondary |
| `fg.2` | `#6a6a6a` | Disabled, placeholder, code comments |
| `fg.heading` | `#ffffff` | H1/H2/H3 in MD |
| `accent` | `#d4a85c` | Amber. Cursor, focused-pane border, active tab top border, MD links |
| `accent.alpha` | `rgba(212, 168, 92, 0.3)` | Selection background |
| `accent.dim` | `#a07c3f` | Inactive accent |
| `error` | `#e85a5a` | Error toasts |
| `success` | `#7fc26b` | Success toasts |
| `border` | `#222222` | 1px borders between surfaces |

**Implementation:** CSS custom properties on `:root`. v0.2's accent presets swap only the `accent` family — everything else stays.

**Typography (layered, not monolithic):**

| Surface | Font family | Size | Notes |
|---|---|---|---|
| UI (labels, top bar, status bar, sidebar, tabs, toasts, buttons) | **Inter** with system fallback (`-apple-system`, `Segoe UI Variable`) | 13px most, 12px status bar | Open-source equivalent of Anthropic's Styrene. Shipped as woff2 inside the binary, ~150KB. |
| Terminal pane (xterm.js content) | **JetBrains Mono** with system fallback (`Consolas`) | 14px (configurable) | Monospace mandatory for terminal output. |
| MD Editor body (prose, headings, lists, blockquotes) | **Inter** | 15px, line-height 1.6 | Same family in both view mode and edit mode so toggling between them feels like a mode switch, not a font change. Reads like Notion/Bear/Obsidian's modern themes. |
| MD Editor code blocks (fenced ` ``` `) | **JetBrains Mono** | 14px | Monospace earns its place only in actual code. |
| `config.toml` opened in MD Editor | **JetBrains Mono** | 14px | Treated as structured code (file extension routing). |

**Frameless titlebar (v0.1):** 36px tall HTML titlebar (Tauri window `decorations: false`). `bg.0` background, 1px `border` bottom. Drag region via `data-tauri-drag-region` on the empty titlebar surface. **All clickable controls inside the titlebar set `data-tauri-drag-region="false"` on their root element** — otherwise clicks on min/max/close buttons register as window drags. Window controls (minimize, maximize, close) on the far right using Lucide icons at 28×36 hit areas, `fg.1` color, `bg.1` hover. Close button hover is `error` color (Windows convention). Double-click drag region toggles maximize. Mica blur is v0.2.

**No gradients. No shadows.** Single 1px borders in `border` color between all surfaces.

---

## 6. `config.toml` schema (v0.1 minimum)

```toml
default_shell = "pwsh"          # one of detected shells

[font]
family = "JetBrains Mono"
size = 14

[terminal]
scrollback_lines = 10000
ipc_batch_ms = 32               # PTY output batching window
ring_buffer_mb = 8              # per-pane scrollback memory cap

[md_editor]
soft_wrap = true
line_numbers = true            # Line numbers shown in MD Editor edit mode
indent_spaces = 2
trim_trailing_whitespace_on_save = true
default_mode = "view"          # "view" (rendered HTML, default) or "edit" (CodeMirror source)

[quick_viewer]
width_pct = 25                  # default Panel width

[sidebar]
visible = true
collapsed_dirs = [           # Folders rendered collapsed-by-default to skip rendering huge trees
  "node_modules",
  ".git",
  "__pycache__",
  "target",                  # Rust build output
  "dist",
  "build",
  ".venv",
  ".next",
  ".turbo",
  ".cache",
]

[theme]
accent = "amber"                # only "amber" in v0.1; v0.2 expands

[log]
level = "info"                  # debug | info | warn | error
path = "%LOCALAPPDATA%\\lume\\logs"

[keybindings]
# Override any key from §7. Example:
# split_right = "Ctrl+\\"
```

Unknown keys produce a warn toast but don't break the load. Invalid values fall back to last-known-valid config.

---

## 7. Keyboard shortcuts (v0.1)

All keybindings configurable in `[keybindings]` of `config.toml`.

| Action | Shortcut |
|---|---|
| Split right | `Ctrl+Alt+→` |
| Split up | `Ctrl+Alt+↑` |
| Split down | `Ctrl+Alt+↓` |
| Focus pane right / left / up / down | `Ctrl+→ / ← / ↑ / ↓` |
| Close focused pane | `Ctrl+W` |
| Toggle Sidebar | `Ctrl+B` |
| Toggle MD Editor Full View | `Ctrl+E` |
| Toggle Quick Viewer | `Ctrl+Shift+M` |
| Open `.md` file | `Ctrl+O` |
| Save | `Ctrl+S` |
| Find in focused element | `Ctrl+F` |
| Find & replace (MD Editor) | `Ctrl+H` |
| Find across all open MD tabs | `Ctrl+Shift+F` |
| Cycle MD Editor tabs | `Ctrl+Tab` |
| Show keyboard shortcuts viewer | `Ctrl+?` |
| Increase / decrease / reset font size | `Ctrl+= / Ctrl+- / Ctrl+0` |
| Copy / paste (in terminal pane) | `Ctrl+Shift+C` / `Ctrl+Shift+V` |
| Copy / paste / cut (MD Editor, Sidebar, non-terminal surfaces) | `Ctrl+C` / `Ctrl+V` / `Ctrl+X` |
| Reset terminal mouse modes (panic key, focused pane only) | `Ctrl+Shift+R` |

### Clipboard convention (terminal-aware)

Clipboard shortcuts are **surface-aware**, not global. Lume routes them based on the focused surface.

- **In a Terminal Pane:** `Ctrl+Shift+C` / `Ctrl+Shift+V`. This is the universal terminal convention — Windows Terminal, iTerm2, WezTerm, Alacritty, VS Code integrated terminal, and Claude Code all use it. The reason:
  - `Ctrl+C` is reserved for **SIGINT** (abort the foreground process). Repurposing it would make every terminal user lose the ability to abort commands.
  - `Ctrl+V` is reserved for **`readline` quoted-insert** ("take the next char literally"). vim and several TUIs also bind it. Repurposing it breaks shell + TUI workflows.
- **In non-terminal surfaces** (MD Editor, Sidebar, Quick Viewer, modals): `Ctrl+C` / `Ctrl+V` / `Ctrl+X` work as normal — these surfaces have no SIGINT or quoted-insert collision.

### Terminal mouse-mode panic key

`Ctrl+Shift+R` (when a Terminal Pane is focused) writes the full sequence to disable every mouse-tracking mode (`?9 / ?1000 / ?1001 / ?1002 / ?1003 / ?1004 / ?1005 / ?1006 / ?1015 / ?1016` all off). Captured in Weekend 0 spike: an app killed with SIGTERM (e.g. `timeout 5 top`) skips its cleanup hook and leaves mouse tracking enabled, after which every cursor movement spams the PTY with reports and the pane becomes unusable from inside. The panic key is the recovery hatch. Additionally, Lume should write the same disable sequence proactively whenever a new PTY is spawned, as defensive hygiene.

### Terminal credibility floor (Plan 012)

Three daily-driver basics, each landed as its own revertable commit:

- **Scrollback search — `Ctrl+F`** (only when a Terminal is the focused surface; the MD editor keeps CodeMirror's own find). A slim overlay bar pins top-right, *below* the pane's corner cluster, and never reflows the xterm grid. Incremental + case-insensitive (`@xterm/addon-search`), `Enter` / `Shift+Enter` step matches, a live `3/17` counter reads from the addon, `Esc` closes and returns focus to the terminal. Match highlights use concrete `#RRGGBB` colours derived from the active theme (xterm decorations reject CSS vars).
- **Ctrl+click web links.** `@xterm/addon-web-links` opens `http(s)` URLs in the OS browser via `openExternal` (`plugin-shell`). **Ctrl/Cmd+click only** — a plain click stays with the shell's mouse modes so agents/TUIs keep their clicks. The webview never navigates.
- **Multiline-paste guard.** Pasting text containing a newline into a terminal asks first (a stray multi-line paste executes in most shells). Confirm pastes the original text byte-identical; cancel sends nothing. Single-line pastes never prompt. Toggle: Settings → Terminal → "Warn on multiline paste" (default ON). Non-terminal surfaces use a different paste path and are untouched.

Reserved for v0.2+: `Ctrl+T` (New Tab), `Ctrl+Tab` at the Lume level.
Reserved for v0.3+: `Ctrl+K` (Spotlight), `Ctrl+Shift+D` (Dashboard).

---

## 8. Notifications / toasts

Position: bottom-right, above the Status Bar with 16px margin. Stack vertically, newest on top, max 4 visible.

- `success`: 3s auto-dismiss. Green left edge (3px).
- `info`: 3s auto-dismiss. Amber left edge.
- `warn`: 6s auto-dismiss. Amber-dim left edge.
- `error`: sticky, must be dismissed. Red left edge.

Animation: 180ms slide-in-from-right + fade. Width auto-fit, 280-480px. `bg.2` background, 1px `border` color.

Triggers (v0.1):
- `success`: file saved, config reloaded, shell switched.
- `info`: first-launch welcome, hot-reload applied, layout restored.
- `warn`: file modified externally (with [Reload] / [Keep mine] action buttons), config invalid value (previous kept), MD Link path missing.
- `error`: PTY spawn failed (inline-in-pane is primary; toast is backup), config parse error, save failed.

### OS attention escape (Plan 011)

The in-app toasts above only reach you when Lume is on screen. Plan 008's
deterministic class-A agent signals *also* escape the window so the fleet can
reach you when Lume is minimized or in the background:

- **Permission block** (an agent is waiting on your approval) → an OS toast
  (`⏸ <Agent> needs permission`, body = session name) + a one-shot taskbar
  flash + the badge.
- **Your move** (turn complete) → the taskbar badge only, by default. Settings →
  Agents → "Toast on turn complete" (default OFF) upgrades it to a toast (never
  a flash).
- **Taskbar overlay badge** always mirrors the fleet needs-you count
  (permission + your-move across background sessions), drawn from the *same*
  `needsYouCounts` selector the status bar chip uses — the two can never
  disagree. Counts render 1–9, then "9+".

Rules (locked): only class-A signals ever escape (heuristics never do); escape
is edge-triggered (fires on *entering* a phase, never on staying); it is
suppressed when the window is focused **and** the session is visible (the
sidebar dot already covers that); a 3 s global min-gap throttles toasts (flash
and badge are exempt). The master "OS notifications" toggle (Settings → Agents,
default ON) gates the whole surface, badge included. All native calls are
best-effort no-ops on failure — attention code never crashes the app. The
decision logic is a pure function (`sessions/attentionEscape.decideEscape`);
the Windows taskbar affordances live in Rust (`src-tauri/src/attention.rs`).

### Workflow coach (Plan 014)

Teach Lume's faster paths at the moment they're needed, without ever becoming
Clippy. Two lanes:

- **Push (the interrupt lane)** — a **Coach Chip**: the pane-overlay grammar of
  the resume banner (absolutely positioned, never reflows the xterm grid,
  presence in/out, reduced-motion safe, never steals focus), anchored to a
  Terminal Pane (selection rescue) or the sidebar/session pair (session thrash).
  It carries ≤10 declarative words, an optional keycap chip, and an explicit
  **Don't suggest this** — never a bare ×. It **auto-fades after 8s** = "not
  now" (counts as its one showing, no penalty). Voice = the video-caption rules:
  declarative, no adjectives.
- **Pull (the shelf)** — a **For you** group in the retitled **Shortcuts & tips**
  modal (Ctrl+?), zero interruption; a 2px dot on the ⌨ icon (≤ once / 7 days,
  cleared on open) is its only escalation.

**Push policy (the admission bar).** A tip may push ONLY for (a) an active
failure the user is experiencing right now, or (b) high-confidence repeated
friction with an immediately relevant, anchorable action. "We noticed you're
inefficient" never qualifies; feature promotion never qualifies — those default
to the shelf. Every push is subject to one global ceiling, **no exemptions**: at
most one unprompted tip per calendar day, at most two in any trailing 7 days, at
most two showings per tip ever. Enforced in one place (`coachStore.tryPush`'s
gate stack) so no detector can re-derive or loosen a threshold.

**Overlay arbitration.** The Coach Chip is the LOWEST-priority occupant of a
pane's top-center slot: `paneOverlayArbiter` ranks resume → attempt-hint →
coach, so the chip never displaces the resume banner or attempt-hint chip — it
simply doesn't show, and does not retry. `PaneSearchBar` stays top-right and
never contends.

**Earned silence.** Every tip has a graduation signal — the taught action (a
Shift-drag selection, a drag-to-split, opening Ctrl+F, a Claude hook event) —
that retires it permanently, including retroactively before it ever fires. The
one **Workflow tips** switch (Settings → Interface, default ON) is observation-
off, not merely surface-off: while OFF, detectors record nothing, arm no timers,
and mutate no history; **Reset learned tips** clears the learned history without
touching the preference. All local, always — the coach emits no telemetry.

---

## 9. Success criteria

### The honest test
Within 8 weeks of starting Weekend 0, the builder has stopped opening Sublime + Windows Terminal + VS Code separately for daily work and instead opens Lume first. If the swap doesn't happen, v0.1 failed.

### Smoothness acceptance test
**Four Panes open simultaneously:**
1. `cargo build` of a real Rust project (colored output, progress redraws).
2. `npm install` on a fresh `node_modules`.
3. A real Claude Code session in WSL generating a long file (alternate-screen, cursor moves, color).
4. Builder is typing in Pane 1 while Panes 2-4 stream output.

**Pass criteria:**
- No visible tearing or flickering in any pane.
- Typing latency in Pane 1 stays under 30ms.
- App memory stays under 500 MB.
- Resizing a Splitter during this test does not crash or freeze any pane.

### Cold start
App launches to interactive state in under 2s cold, under 1s warm.

---

## 10. Risks & unknowns (with mitigations)

1. **ConPTY behavior on Windows.** `portable-pty` supports ConPTY but ConPTY can rewrite ANSI escape sequences in ways xterm.js renderers can't fix downstream. Windows 11 24H2 has `PSEUDOCONSOLE_PASSTHROUGH_MODE` which improves this; `portable-pty` support may lag.
   - **Mitigation:** Pre-Weekend-1 spike runs a real Claude Code session in a `portable-pty`-driven xterm.js pane and compares visually to Windows Terminal. If artifacts are obvious, revisit stack.

2. **Tauri v2 IPC backpressure.** Tauri events aren't flow-controlled.
   - **Mitigation:** Batch PTY output on Rust side (32ms window), emit binary chunks, cap per-pane buffer at 8 MB, drop oldest on overflow.

3. **xterm.js + WebGL context limits.** Browsers cap WebGL contexts per page (~16 practical limit). 4-6 panes fine; "open a dozen" may not be.
   - **Mitigation:** Lazy-init WebGL for visible panes only; canvas fallback for offscreen / dashboard-only.

4. **DPI scaling on Windows.** xterm.js WebGL font atlas breaks across DPI changes.
   - **Mitigation:** Listen for `window.devicePixelRatio` changes, re-init renderer on transition.

5. **xterm.js inside React lifecycle.** Re-renders that recreate the terminal lose scrollback.
   - **Mitigation:** xterm.js instance in module-level `Map`; mount once via empty-deps `useEffect`; pane component `React.memo`'d.

6. **CodeMirror 6 ESM loading in Tauri v2.** Vite config can be finicky.
   - **Mitigation:** Use official CM6 examples as template, not React wrappers.

7. **WebView2 runtime on Windows.** Windows 11 has it; some Windows 10 corporate machines don't.
   - **Mitigation:** Use Tauri's bundled-WebView2 installer option for v0.1.

8. **Synthetic smoothness tests deceive.** A `for i in 1..10000; echo $i` loop passes on the easiest possible workload.
   - **Mitigation:** Acceptance test (§9) uses real concurrent agent workloads.

9. **xterm.js theme atlas regenerates on theme/font change.** The WebGL renderer caches glyph atlases per (font, theme) combination. Changing the accent color (or any theme key) via hot-reload from `config.toml` forces atlas regeneration → brief visible flash in every Terminal Pane.
   - **Mitigation v0.1:** Accept the flash. It only happens on explicit theme edits, which are rare.
   - **Mitigation v0.2+:** Debounce accent changes to commit at most every 500ms; pre-warm atlases for the 5 preset accents on startup.

10. **markdown-it XSS vector.** The Preview Pane renders user-controlled markdown inside the Tauri webview. Embedded HTML (`<script>`, `<img onerror=...>`) would execute with Tauri command access.
    - **Mitigation (mandatory):** markdown-it config locked to `{ html: false, linkify: true, breaks: true }`. Output passes through DOMPurify before DOM injection. Both layers; defense-in-depth.

11. **Windows 11 snap layouts lost on frameless titlebar.** `decorations: false` removes the OS chrome that provides the hover-maximize-to-snap-layouts UX. Restoring it requires implementing the `WM_NCHITTEST` hint via a custom Tauri plugin or window event handler.
    - **Mitigation v0.1:** Known visual gap. Snap-via-keyboard (Win+←/→) still works. Accept and document.
    - **Mitigation v0.4+ (cross-platform polish):** custom titlebar plugin or `tauri-plugin-window-state` integration.

---

## 11. Distribution plan

- **Repo:** Public GitHub from day one, MIT license.
- **v0.1 release:** Windows MSI only, unsigned. README documents SmartScreen workaround.
- **v0.2 release:** macOS DMG (unsigned initially), Linux AppImage. GitHub Actions matrix added then.
- **v0.3+:** Code signing (Windows certificate + macOS notarization).
- **Auto-update:** Tauri v2 built-in updater, wired in v0.2.

---

## 12. Build plan (v0.1 weekends)

### Weekend 0 — Spike (4-6 hours, BEFORE Weekend 1)
Goal: confirm the stack is viable before sinking real weekends.

1. Build a single-file Tauri v2 app with one xterm.js + WebGL pane.
2. Wire to a real PTY via `portable-pty` on Windows ConPTY.
3. Spawn `pwsh`.
4. Run a real Claude Code session (via WSL pane). Generate a 200-line file with diff output.
5. Compare visually to running the same session in Windows Terminal.

**Decision gate:**
- Rendering as good as Windows Terminal → proceed to Weekend 1.
- ConPTY artifacts visible → pause, revisit stack.

### Weekend 1 — Smoothness baseline
1. Scaffold real project (React + Vite + Tauri v2 + Zustand + Immer + Devtools middleware).
2. PTY plumbing: Rust side does 32ms batched binary events, ring buffer.
3. xterm.js component with strict `useRef` lifecycle, `Map<paneId, Terminal>` registry, `React.memo`.
4. ONE basic CI workflow on `windows-latest` runs `npm test` + `cargo test` on push.
5. Run smoothness acceptance test (§9) with 4 concurrent workloads.
6. **If it fails:** stop and fix architecture before adding features.

### Weekend 2 — Tiling
1. Binary tree pane model in `layoutStore` (with Immer).
2. `react-resizable-panels` integration; splitter resize sub-pixel smooth.
3. Split right / up / down via keyboard (Ctrl+Alt+→/↑/↓). Top-bar Split menu popup deferred to Weekend 4 alongside the frameless titlebar / top bar; keyboard shortcuts alone satisfy the v0.1 functional requirement until the top bar exists.
4. Focus model: focused pane owns all keys except global set.
5. Close behavior: last-pane lock (enforced at `layoutStore.closePane`). Active-process confirm dialog deferred to Weekend 3 — needs shell integration (OSC 7 or process-tree query) to know when a process is actually running vs. the shell sitting at a prompt; fires-every-time confirm is worse UX than no confirm and was rejected.
6. Vitest tests for pane tree ops (split/close/focus pure functions).
7. Re-run smoothness test with 4 tiled panes.

### Weekend 3 — Markdown + Preview + Sidebar + Shell support
1. CodeMirror 6 integration (vanilla) for MD Editor Full View edit mode (Quick Viewer is rendered-only).
2. Inter + JetBrains Mono font loading (bundled woff2).
3. MD Editor Tab Strip with simple tabs (no persistence, no unsaved-prompt for v0.1).
4. MD Editor Full View: single-pane body that toggles between rendered HTML view (markdown-it + DOMPurify, default) and CodeMirror source edit mode via a pen icon in the top-right toolbar. Tab switches reset the mode to view.
5. MD Quick Viewer as resizable right Panel (default 25%, min 250px, max 60%).
6. Ctrl+Click MD Link detection in terminals via xterm.js `registerLinkProvider`.
7. File tree Sidebar with filter input and new-file icon.
8. Shell auto-detection on launch: pwsh, powershell.exe, cmd.exe, WSL distros via `wsl.exe -l -v`.
9. Per-pane "Change Shell..." right-click menu.

### Weekend 4 — Frameless titlebar + Config + Theme + Status bar
1. Frameless titlebar (`decorations: false`); custom HTML titlebar with drag region and Lucide icon controls.
2. `~/.lume/config.toml` schema (§6); `notify` file watcher; hot reload.
3. Settings gear opens `config.toml` in MD Editor tab.
4. "Amber on Black" theme via CSS custom properties.
5. Status Bar with focused-element segment + workspace summary + active-process indicator.
6. Layout / Workspace Folder / Sidebar visibility persistence (Zustand `persist` middleware).

### Weekend 5 — Tests, CI, release
1. Vitest tests for:
   - layoutStore pure functions (splitPane / closePane / focusPane / moveFocus / resizePane / last-pane invariant).
   - mdStore tab lifecycle (open / close / switch / dirty / save / close-with-dirty).
   - settingsStore.parseConfig (valid / invalid / missing-fields TOML).
   - **Focus dispatcher** — given a keystroke and a focused pane type, asserts correct routing. Critical to feel-good and easy to regress.
   - **data-tauri-drag-region propagation regression test** — walks the titlebar DOM and asserts every clickable control has `data-tauri-drag-region="false"`. Prevents the "I added a new icon and forgot the attribute" bug.
2. `cargo test` for:
   - `pty.rs` spawn success / spawn failure / input / resize / close.
   - `config.rs` load with valid / missing / invalid TOML.
   - `shell_detect.rs` with mocked PATH and mocked `wsl.exe -l -v` output.
3. GitHub Actions workflow on `windows-latest`: `npm test` + `cargo test` on push.
4. App icon.
5. Tauri build → MSI installer.
6. Push to GitHub. Tag v0.1.0.

### Weekend 6-8 — Buffer
Reserved for the inevitable overruns from the frameless titlebar + preview pane work. Spec assumes 6-8 weekends total; if you finish in 5, that's gravy.

---

## 13. Out of scope (v0.1)

Permanently skipped:
- Markdown-can-spawn-agents (executable checkboxes/links in MD).
- Session recording / replay (.cast files).
- AI agent integration (Warp's "Open AI agent" pattern).

Deferred to v0.2+:
- Tabs (Lume-level).
- Mac-native polish layer (Mica blur, frameless titlebar, spring animations).
- MD Editor unsaved-prompt, tab persistence, tab overflow handling.
- 5 accent presets.
- Top-bar Split menu icon, Keyboard shortcuts viewer icon.
- Git Bash shell support.

Deferred to v0.3+:
- Spotlight Ctrl+K modal.
- Dashboard view + drag-to-reorder MD tabs.

Deferred to v0.4+:
- Pane drag-and-drop.
- Recent MD files in Sidebar.
- OSC 7 shell integration.
- macOS / Linux installers + matrix CI.
- Code signing.
- Plugin / theme system.

---

## 14. Open items before Weekend 0

1. **Project name.** Working candidates: Pier, Dock, Loft, Quay, Workbench, Helm. Need to pick before v0.1 release; not blocking Weekend 0 code.
2. **Repo creation.** Decide on GitHub repo name and create it before Weekend 1.
3. **Pre-installed dependencies on the dev machine.** Rust, Node.js LTS (or Bun), Tauri CLI, Visual Studio Build Tools, WebView2 (already on Win11), at least one WSL distro.

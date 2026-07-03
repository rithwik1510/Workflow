# Plan 011: Attention escape — the dot leaves the window (Beta Loop 1)

## Status

APPROVED — design locked with the operator 2026-07-03:
- **permission** → toast + taskbar flash + badge (the urgent one).
- **your-move** (turn complete) → badge only; a settings toggle "Toast on
  turn complete" (default OFF) upgrades it.
- Master "OS notifications" toggle, default ON.
- Heuristic signals NEVER escape (Plan 008's routing rule is law).
Execution: spike gate first (step 0); then worktree branch per repo
convention; Fable reviews before merge. Implement FIRST of the Beta three.

## Goal

Plan 008's exact signals currently end at a sidebar dot visible only while
Lume is focused. Close the attention loop for the minimized/unfocused case:

1. OS toast: `✻ Claude — waiting on permission · <session name>`.
2. Taskbar: overlay badge showing the fleet needs-you count; one-shot flash
   on a new permission block.
3. Click → context: activating the toast (if the spike proves Windows
   activation callbacks) focuses Lume, activates the session, focuses the
   signaling pane. Guaranteed floor if not: flash + badge, and the sidebar
   dot finishes the routing once the user clicks the taskbar.

## Reliability grounding (all existing)

- Truth: `agentTracker` class-A transitions (hook events; no guessing).
- Ranking/roll-up: `sessionSignal.ts` — the badge count MUST be the same
  selector the StatusBar uses (extract, don't duplicate).
- Jump: `activateSession` + `setFocusedPane` (+ optional pane zoom later).

## Step 0 — SPIKE GATE (Windows 11; dev AND packaged)

Throwaway branch; PASS required before real code:
1. `tauri-plugin-notification`: toast renders while the window is unfocused
   and while minimized. Record dev-mode behavior (WebView2 apps without
   packaged identity sometimes can't toast — if dev can't, packaged must).
2. Click activation: does the app receive any callback when the user clicks
   the toast body on Windows desktop? (Plugin actions are mobile-first;
   expect NO — then click-routing is dropped and flash+badge is the floor.
   Document the finding in the plan file.)
3. Badge: `window.set_overlay_icon(Some(Image))` renders a legible 16×16
   overlay; `set_overlay_icon(None)` clears it. `request_user_attention
   (Some(Informational))` flashes without stealing focus, and stops when
   the user focuses Lume.

## Detailed design

### Escape decision (pure function, unit-tested exhaustively)

`src/sessions/attentionEscape.ts`:

```
decideEscape(input: {
  transition: { paneId, from: AgentPhase, to: AgentPhase },
  windowFocused: boolean,
  sessionVisible: boolean,   // getVisibleSessionIds covers split view
  prefs: { osNotifications: boolean; toastOnTurnComplete: boolean },
  now: number, lastToastAt: number,
}): { toast?: { title, body }, flash: boolean }
```

Rules:
- Edge-triggered only: fire on ENTERING `permission` (or `your-move` with
  the toggle), never on remaining in it, never on re-renders.
- Suppressed entirely when `prefs.osNotifications` is off.
- Suppressed when `windowFocused && sessionVisible` (the in-window dot
  already covers it). Unfocused OR hidden-session → escape.
- Global min-gap 3 s between toasts (`lastToastAt`); flash has no gap (the
  OS coalesces flashes).
- Toast copy: title `⏸ <Agent> needs permission` / `✓ <Agent> finished`,
  body = session name. Reuse `agentLabel`. No prose beyond that — the copy
  IS the design (minimal, trustworthy).

The badge is NOT edge-triggered — it always mirrors the current fleet count.

### Wiring

- Module-scope subscription (the agentTracker visibility-ack pattern):
  subscribe to `useAgentStore`, diff pane phases against a module-level
  prev-map, feed transitions into `decideEscape`, act on the result.
- Window focus: cache from `getCurrentWindow().onFocusChanged`; initialize
  from `isFocused()`. On focus gain: clear flash state; badge recomputes
  (it will typically drop as the user acknowledges panes).
- Badge count selector: extract `needsYouCounts(panes, sessions)` into
  `sessionSignal.ts`; StatusBar switches to it in the same commit (single
  source of truth); attentionEscape subscribes and invokes
  `set_needs_you_badge(permissionCount + yourMoveCount)` — debounced 250 ms
  trailing (badge writes cross IPC).

### Rust (`src-tauri/src/attention.rs`)

- `set_needs_you_badge(count: u32)`: count == 0 → `set_overlay_icon(None)`;
  else pick from 10 embedded PNGs (`assets/badge/1.png` … `9.png`,
  `9plus.png`, 16×16, accent circle + white numeral, pre-rendered — no
  runtime text rasterization). `include_bytes!` + `Image::from_bytes`
  (enable the tauri `image-png` feature). Idempotent; missing window or
  platform failure = silent no-op (attention must never crash the app).
- `flash_taskbar()`: `request_user_attention(Some(Informational))`.
- `tauri-plugin-notification` registered; capability `notification:default`.
  Toasts are SENT FROM RUST? No — sent from TS via the plugin's JS API
  (simpler, and the decision logic lives in TS where the state is).

### Settings (new `prefsStore`)

`config.toml`/settingsStore is schema-locked Rust config (deny_unknown_
fields) — behavioral UI prefs don't belong there (precedent: Plan 009 put
auto-resume in paneResumeStore). Create `src/store/prefsStore.ts`: a small
persisted zustand store for UI behavior prefs. Seed it with
`osNotifications: true`, `toastOnTurnComplete: false`. (Plan 012's paste
pref joins it.) SettingsModal → Agents section gains two `SettingRow` +
`Toggle` rows matching the existing rows exactly.

## Steps

1. Spike (step 0) → record findings in this file under "Spike results".
2. Rust `attention.rs` + badge assets + plugin registration + cargo tests
   (badge command tolerates repeat calls / no window).
3. `prefsStore` + Settings rows (+ vitest).
4. `needsYouCounts` extraction into sessionSignal + StatusBar switch
   (+ parity test).
5. `attentionEscape.ts`: decideEscape (pure) + subscription wiring + badge
   debounce (+ the full vitest matrix: transition × focused × visible ×
   prefs × gap).
6. Click routing IF spike passed activation; else document the floor.
7. Docs: DESIGN.md signals section, README, CHANGELOG.

## Testing gates

vitest + typecheck + build; cargo test/clippy/fmt. Manual (operator):
minimize → real permission prompt → toast + flash + badge; approve → badge
clears; focused+visible → no toast; toggle OFF → silence; turn-complete
toggle ON → its toast.

## Risks

- Toast behavior differs dev vs packaged → spike covers both; worst case
  the feature is packaged-only and dev logs a hint.
- Badge overlay is Windows-only API → fine; Lume is Windows-first. The
  attentionEscape layer is platform-agnostic, the Rust commands no-op
  elsewhere.

## Out of scope

Sounds (follow-up after toasts earn trust), remote/mobile delivery, stale-
state re-notification ("still blocked after 5 min"), any heuristic escape.

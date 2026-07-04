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

## Spike results (2026-07-03)

The spike ran in an environment where a GUI cannot be observed, so it was split
into (a) a **static/compile-time verification** done here and (b) an **operator
verification checklist** for the reviewing human/agent to run live. No live
runtime behavior is claimed below beyond what compiles and unit-tests.

### (a) Compile-time / API verification — DONE

Versions in play (from `src-tauri/Cargo.lock`): `tauri 2.11.5`,
`tauri-plugin-notification 2.3.3`. npm `@tauri-apps/plugin-notification ^2.3.3`.

- **Overlay badge API.** `WebviewWindow::set_overlay_icon(Option<Image>)` exists
  and is **`#[cfg(target_os = "windows")]`** — so `set_needs_you_badge` is
  cfg-gated to Windows and is a silent no-op elsewhere (confirmed: compiles,
  clippy-clean).
- **Runtime-composed badge (deviation from the plan, approved in the build
  brief).** Instead of shipping 10 pre-rendered PNGs + the `image-png` Cargo
  feature, the 16×16 RGBA buffer is composed at runtime from a tiny embedded 3×5
  bitmap font (`attention::render_badge_rgba`) and handed to
  `tauri::image::Image::new_owned(Vec<u8>, 16, 16)` — a `const fn` needing **no
  image-format feature**. This made the rasterizer a pure function with 5 unit
  tests (buffer size, disc opacity/transparency, ink presence for 1..=9 and
  "9+", ink-inside-disc legibility guarantee). Counts render 1–9, then "9+".
- **Flash.** `WebviewWindow::request_user_attention(Some(UserAttentionType::
  Informational))` exists cross-platform; `flash_taskbar` wraps it. Both native
  commands swallow every error (missing window / platform failure = no-op).
- **Toast.** Sent from TS via the plugin's `sendNotification`; permission is
  requested once at wiring install (`ensureNotificationPermission`). Capability
  `notification:default` added to `capabilities/default.json`.
- **Click-to-context routing: DROPPED to the floor (approved outcome).** The
  desktop notification plugin (2.3.3) exposes `onAction`/`registerActionTypes`,
  but reliable *body-click* activation with a focus-the-pane callback on Windows
  desktop is not something this build could verify without a live GUI, and the
  plan pre-authorized dropping it. Implemented floor: **flash + badge**, and the
  in-window sidebar dot completes the routing once the user clicks the taskbar
  button. `activateSession`/`setFocusedPane` were left untouched. If a later
  spike confirms activation callbacks, wire them in `attentionEscape` where the
  toast is sent (single touch-point).

### (b) Operator verification checklist — RUN LIVE (Windows 11)

Run twice: once in **dev** (`npm run tauri dev`) and once in a **packaged**
build (`npm run tauri build` → run the installed exe). WebView2 apps sometimes
can't toast without packaged identity, so if dev can't toast, packaged must.

1. **Toast while unfocused.** Enable Settings → Agents → "OS notifications"
   (default ON). Launch `claude` in a pane, minimize Lume, drive it to a real
   permission prompt. EXPECT: an OS toast `⏸ Claude needs permission` / body =
   session name. Record dev vs packaged (pass/fail each).
2. **Taskbar flash on the block.** Same trigger. EXPECT: the taskbar button
   flashes once and stops the instant you focus Lume; it does not steal focus.
3. **Overlay badge legibility.** With ≥1 background session needing you, EXPECT
   a red disc badge with a white numeral on the taskbar button. Check 1, a
   two-digit count (shows "9+"), and that approving/acknowledging clears it
   (badge → none at count 0). Confirm the numeral is legible at 16×16.
4. **Suppression when you're looking.** Focus Lume with the signaling session
   on-screen (foreground or in split view). EXPECT: no toast, no flash (the
   badge still reflects background counts only).
5. **your-move is badge-only.** Let a turn complete for a background session
   with "Toast on turn complete" OFF. EXPECT: badge increments, NO toast, NO
   flash. Turn the pref ON, repeat. EXPECT: a `✓ Claude finished` toast (still
   no flash).
6. **Master switch.** Turn "OS notifications" OFF. EXPECT: no toast, no flash,
   and the badge clears to none even while sessions still need you.
7. **Toast min-gap.** Trigger two permission blocks <3 s apart. EXPECT: at most
   one toast in that window; both still flash.
8. **Never crashes.** None of the above should ever produce an error dialog or
   crash — failures degrade to silence.

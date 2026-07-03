# Plan 011: Attention escape — the dot leaves the window (Loop 1)

## Status

PROPOSED — drafted 2026-07-03 from operator direction ("Loop 1 and Loop 2 are
definitely something that we want"). Design decisions below marked LOCK are to
be confirmed with the operator before implementation. Spike gate (step 0)
gates everything, mirroring Plan 008's discipline.

## Goal

The Plan-008 signal machinery currently ends at a sidebar dot that is only
visible while Lume is focused. The moment that matters most is when it ISN'T:
the user is in the browser/meeting and an agent has been blocked on a
permission prompt for minutes. Close the loop:

1. **OS toast** when a background/unfocused agent needs the user
   (`✻ Claude — waiting on permission · <session>`).
2. **Taskbar signal**: overlay badge (needs-you count) + one-shot taskbar
   flash for permission events.
3. **Click → context**: activating the notification (or the app) lands the
   user on the right session.

## Why this is reliable with what we already have

| Need | Already built |
|---|---|
| "Needs you" truth, no guessing | agentTracker class-A transitions (Plan 008): `permission`, `your-move` — deterministic hook events, never cadence guesses |
| One ranking of urgency | `sessionSignal.ts` (`computeSessionSignal`, `rollUpSignal`) |
| Fleet needs-you count | StatusBar roll-up already computes it (memoized) |
| Jump-to-session | `activateSession` + (Plan zoom) `toggleZoomPane` |

**The locked routing rule stands: ONLY deterministic class-A signals may
escape the window.** Heuristic tiers (OSC 133 / cadence) stay in-window
forever. This is the entire reason 008 exists; it is what makes Lume's pings
trustworthy where competitors cry wolf.

## Design (LOCK each with the operator)

- **Which signals escape** — LOCK proposal:
  - `permission` → toast + badge + taskbar flash (blocked mid-turn = urgent).
  - `your-move` (turn complete) → badge only, no toast by default (a settings
    toggle "Toast on turn complete" enables it, default OFF). Rationale: with
    4 agents, turn-complete toasts become spam; permission almost never does.
  - Nothing else. Ever.
- **Suppression**: no toast/flash when the Lume window is focused AND the
  signaling session is visible (the in-window dot already covers it). Badge
  always reflects the true count.
- **Debounce**: one toast per pane per signal-transition (state-edge
  triggered, not repeated); a global min-gap (e.g. 3 s) between toasts.
- **Click behavior**: toast click → show + focus window, `activateSession`,
  focus the signaling pane. If Windows toast activation proves unreliable in
  the spike, fallback = flash + badge only (clicking the taskbar still lands
  on Lume with the session dot lit).
- **Settings** (SettingsModal → Agents): master "OS notifications" toggle
  (default ON once hooks are installed), the your-move toast toggle.

## Step 0 — SPIKE GATE (Windows 11, packaged + dev)

Verify before any real code, in a throwaway branch:
1. `tauri-plugin-notification` v2: toast shows while window unfocused/
   minimized; behavior of click (does the app get an activation callback on
   Windows? If not, document and drop click-routing to the fallback).
2. Taskbar badge: Tauri v2 `set_overlay_icon` (Windows) with a count glyph;
   `request_user_attention(Informational)` flash semantics (once vs until
   focus).
3. Confirm toasts work for a WebView2 app without a packaged identity (dev
   mode) — if dev-mode toasts are unavailable, note it and test packaged.

PASS = toast visible when minimized + badge/flash render. Click-activation is
nice-to-have, not a gate.

## Steps

1. Rust: add `tauri-plugin-notification`; a tiny `attention.rs` with commands
   `set_needs_you_badge(count)` (overlay icon, cached rendered glyphs 1–9+)
   and `flash_taskbar()`. All UI-thread-safe, no-ops on failure.
2. TS `src/sessions/attentionEscape.ts`: subscribes to agentStore transitions
   (module-scope, like agentTracker's visibility subscription). Computes
   escapes per the Design rules; talks to the notification plugin + badge
   commands. Window-focus state via Tauri window events.
3. Badge count = the StatusBar roll-up selector, extracted to a shared
   selector so StatusBar and the badge can't disagree.
4. Click routing (if spike PASSed): notification activation → focus window →
   `activateSession(sessionId)` → focus pane.
5. Settings rows + docs (DESIGN.md signals section, README).

## Testing gates

- vitest: escape-decision matrix (signal × focused × visible × settings ×
  debounce) as a pure function; badge-count selector parity with StatusBar.
- cargo: badge command tolerates missing window / repeated calls.
- Manual (operator): minimize Lume, trigger a real permission prompt →
  toast + flash + badge; approve → badge clears. Turn-complete with toggle
  ON/OFF. Focused window → no toast.

## Risks

- Windows toast activation callbacks are the flaky part → that's why the
  spike, and why flash+badge is the guaranteed floor.
- Toast fatigue → the permission-only default and state-edge debounce are
  the product answer; the master toggle is the escape hatch.

## Out of scope

Sounds (follow-up once toasts prove trustworthy), mobile/remote delivery,
any escape for heuristic signals (never).

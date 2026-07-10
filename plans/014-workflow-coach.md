# Plan 014: Workflow coach — rescue tips + a quiet shelf

## Status

DRAFT v3 — 2026-07-10, awaiting operator review. v1 and v2 were reviewed
2026-07-10 (all substantive points accepted — see "Review deltas" at the
bottom). No dependencies on open plans; builds only on shipped surfaces
(008 agent identity, 011 prefsStore, 012 search/paste patterns, the overlay
grammar from 009/013, beta.8 split pairs).

## Goal

Teach efficient Lume workflows at the moment they're needed, without ever
becoming Clippy. Users who already know a feature never hear about it; users
who don't see **at most one unprompted tip per calendar day, at most two in
any trailing 7 days, at most two showings per tip ever — no exemptions**.
Everything else waits silently in a place they visit by choice.

**Push policy (the admission bar for the interrupt lane):** a tip may push
only for (a) an **active failure** the user is experiencing right now, or
(b) **high-confidence repeated friction with an immediately relevant,
anchorable action**. "We noticed you're inefficient" never qualifies;
feature promotion never qualifies.

Two lanes, four Phase A tips:

1. **Interrupt lane (push):**
   - **Failed TUI selection** (active failure) — the user drags to select
     inside a mouse-reporting app, gets nothing, then presses Ctrl+Shift+C
     on the empty selection: explicit proof they believe something is
     selected. Chip on that pane: *"Hold Shift while dragging to select
     inside this TUI."*
   - **Session thrash** (high-confidence friction) — ≥ 6 deliberate
     switches between the same two sessions within 10 minutes. Chip
     anchored at the two sidebar rows: *"Keep these together — drag one
     onto the other to split."* Pushes once (budget permitting), then the
     tip is preserved on the shelf so the advice survives the moment.
2. **Shelf lane (pull)** — rows in a **"For you"** section of the Ctrl+?
   modal (retitled **"Shortcuts & tips"**). Zero interruption. Phase A:
   - **Precise-signals intro** — when a `claude` pane remains command-identified
     with no hook events for 30s, the existing on-disk hooks-status command
     confirms hooks are not installed before shelving (no multi-day evidence
     needed). Neutral copy: *"Claude detected — enable
     Precise Claude Code signals for exact permission & turn states
     (Settings → Agents)."* This is promotion, not friction, so it never
     pushes (v1 had it in the interrupt lane; that violated the push
     policy, and its copy — "that dot was a guess" — undermined the
     fallback signals right after they worked).
   - **Scroll-hunting → Ctrl+F** — episodes on 2 distinct days shelve it.

## Why this shape (the annoyance ceiling is structural)

- The push bar is stated as policy above; future tips default to the shelf
  and must argue their way past (a) or (b) explicitly in review.
- The shelf can afford looser thresholds because it costs zero attention;
  it gives every future tip (git-diff→Diff-tab, URL-copy→Ctrl+Click,
  rename-your-sessions…) a home that doesn't spend the push budget.
- Success metric is **earned silence**: every tip has a graduation signal
  (the user performs the taught action) that retires it permanently —
  including retroactively, before it ever fires.

## Why contained (M, not S — but every seam is already ours)

Two surfaces, one persisted store, four detectors, terminal DOM listeners,
and cross-store gates: this is a solid M. What keeps it contained:

- `src/terminals/registry.ts` owns the key/copy/paste path. The failed-copy
  evidence point already exists as a dead branch: Ctrl+Shift+C with an
  empty selection is consumed and does nothing (registry.ts ~180–190) —
  the detector hooks that exact branch. The mouse-reporting trap is already
  documented in prose (registry.ts:168–171); `term.modes.mouseTrackingMode`
  tells us when the TUI owns the mouse.
- `agentStore.PaneAgent` already distinguishes `source: "hook"` from
  `"command"`. A pane with `agent === "claude" && source === "command"`
  sustained ≥ 30s is the trigger to call the existing `claudeHooksStatus()`
  client once; no new Rust command or periodic probing is needed.
- The drag-split success seam is one line: `internalSessionDrag.ts:95`
  (`if (dropped) … openSplitWith(sessionId)`).
- ShortcutsModal CATALOG, overlay grammar (PaneResumeBanner per-pane,
  AttemptHintChip top-center + yield protocol), presence in/out, keycap
  chips, prefsStore + SettingsModal rows, `tauriPersistStorage` — all
  established precedents.

## Detailed design

### 1. TIP_CATALOG + COACH_TUNING (one file: `src/sessions/coachCatalog.ts`)

Declarative catalog, one entry per tip:
`{ tipId, lane: "push" | "shelf", copy, keycaps?, lifetimeCap,
graduation: description, anchorKind }`. All numeric thresholds live in an
exported `COACH_TUNING` object beside it. Adding tip #5 later = one catalog
entry + one detector.

### 2. coachStore

**Persisted** (`lume-coach.json`): per-tip `{ shownCount, dismissedAt?,
graduatedAt?, shelvedAt?, episodeDays: string[] }` (days as `YYYY-MM-DD`,
**bounded to a trailing 14-day window**); global `{ pushDates: string[]
(bounded 7), quietUntil?, shelfHasNew: boolean, lastShelfDotAt? }`.
`quietUntil` and `lastShelfDotAt` are epoch-millisecond timestamps;
`pushDates`/`episodeDays` are local-calendar day strings. `shelfHasNew` is set
only when a newly-shelved tip is allowed to light the 7-day-capped top-bar dot,
and is cleared when the shortcuts/tips modal opens.

**Ephemeral (NOT persisted)** — what CoachChip currently renders:

```ts
activeTip: {
  tipId: TipId;
  anchor: { kind: "pane"; paneId: PaneId }
        | { kind: "session-pair"; sessionIds: [SessionId, SessionId] };
  payload?: Record<string, string>;   // e.g. the pair's display names
  shownAt: number;
} | null
```

Actions: `recordEpisode`, `tryPush(tipId, anchor, payload?) → boolean`
(applies every gate atomically, sets `activeTip` on success),
`clearActiveTip()`, `shelve`, `markShelfOpened`, `graduate`,
`dismissForever`, `resetLearnedTips()`.
`activeTip` clears on auto-fade, on anchor death (pane disposed / either
session deleted), on graduation, and when Workflow tips is toggled off.
`resetLearnedTips()` clears learned/notice history and `activeTip` but does
not change the user's `tipsEnabled` preference. The engine takes an injected
`now: () => number` so time-dependent tests don't need global fake timers.

### 3. The gates (inside `tryPush`, in order)

1. `tipsEnabled` pref ON (prefsStore, default ON; SettingsModal row
   "Workflow tips" under Interface, with a **"Reset learned tips"** action
   beside it). This is a true master switch: while OFF, detectors do not
   record episodes, arm timers, call hooks status, shelve tips, or mutate
   coach history; existing learned state remains dormant until re-enabled.
2. Not graduated, not dismissed, `shownCount < lifetimeCap`
   (selection rescue 2; session thrash 1 — it pushes once, then shelf).
3. Global quiet: `dismissForever` on any push tip sets
   `quietUntil = now + 7d` — explicit dismissal is feedback about the
   *system*, not just the tip.
4. **Budget, one rule, no exemptions:** no push yet this calendar day, AND
   ≤ 2 pushes in the trailing 7 days. (v1 exempted rescues from the weekly
   cap and allowed per-tip dailies — contradictory and looser than the
   goal; start strict, loosen later with evidence.)
5. Timing seam: not within 2s of terminal input (see §5), not while any
   session is blocked-on-permission (the dot outranks the coach, always),
   not in the app's first 2 minutes.
6. Slot free (pane anchors only): the coach chip is the LOWEST-priority
   occupant of the pane's top-center slot — it never displaces the resume
   banner or attempt hint chip; it simply doesn't show (and does NOT retry
   later that day). The sidebar-pair anchor has its own geometry and does not
   participate in pane-overlay arbitration.

### 4. Detectors (wired from one module: `src/sessions/coach.ts`)

- **Failed TUI selection** (push, rescue): evidence chain, per pane —
  (1) pointerup after > 24px drag travel, `!shiftKey`,
  `term.modes.mouseTrackingMode !== "none"`, `term.getSelection() === ""`;
  (2) within 4s, Ctrl+Shift+C arrives at the registry's copy handler and
  finds no selection (the currently-dead consume branch). Both → `tryPush`.
  Plain Ctrl+C is NEVER evidence — with no selection it intentionally
  means SIGINT. Graduates on the first successful Shift+drag selection in
  any mouse-reporting pane.
- **Session thrash** (push then shelf): detection is NOT a raw
  `activeSessionId` subscription (that would count boot restore,
  programmatic activation, split-pair reopen, deletion/stop transitions,
  and clicks between already-visible split panes). Instead, deliberate
  navigation entry points (sidebar row click, keyboard session cycling)
  emit `noteSessionNavigation({ from, to, source: "sidebar" | "keyboard",
  at })`; navigation while a split view is already open is ignored (both
  sessions are visible — no friction). An episode = ≥ 6 alternations
  between the same pair within 10 minutes → `tryPush` with the
  session-pair anchor + the pair's names in `payload`; regardless of push
  outcome the tip is shelved with generic durable copy so the advice
  persists; pair names exist only in ephemeral `activeTip.payload`, avoiding
  stale names and an undefined multiple-pair persistence model. Graduates
  immediately on coach installation if durable `splitGroups` proves the user
  already knows the feature, or later at the drag-drop success seam —
  `internalSessionDrag.ts:95`, immediately after `openSplitWith`, only
  when a genuine split was created or changed (not the no-op self-drop,
  not durable-pair restore).
- **Precise-signals intro** (shelf only): `agentStore` entry with
  `agent === "claude" && source === "command"` sustained ≥ 30s (rules out
  ordinary hook latency on session start) → call `claudeHooksStatus()` once.
  False → shelve; true → graduate/suppress. Any hook event also graduates
  immediately. The detector never infers "hooks off" from command identity
  alone and never polls status continuously.
- **Scroll-hunt** (shelf): `term.onScroll` — episode = viewport ≥ 300
  lines above bottom with ≥ 10s dwell, twice in one app run, search never
  opened. Episodes on 2 distinct days → shelve. Graduates the first time
  paneSearchStore opens — observed independently, so an existing Ctrl+F
  user is retro-graduated before the tip can ever shelve.

### 5. Instrumentation seams (metadata only, never content)

- `noteTerminalInput(paneId, at)` — called from the registry input path;
  stores only a timestamp (never keys or text). Feeds gate 5.
- `noteSessionNavigation(…)` — as above; stores only ids/source/time.

### 6. Listener ownership & lifecycle (explicit, from v1 review)

- Selection pointer listeners attach in capture phase **after `term.open()`**
  (when `term.element` exists), observe without `preventDefault` or mutation,
  and are keyed on the registry entry so DOM reparenting (layout changes,
  split moves) never double-registers; removed in `disposeTerminal`. A plain
  drag candidate requires Shift to be absent at both pointer-down and
  pointer-up; graduation requires a Shift-drag that produces a real selection.
- Scroll-hunt dwell timers are cleared when: the viewport returns to the
  bottom; search opens; the terminal is disposed; `tipsEnabled` turns off;
  the coach wiring module is disposed (HMR/tests expose a `dispose()`).
- Every detector entry point begins with the same `tipsEnabled` guard; turning
  tips off is observation-off, not merely surface-off. Re-enabling starts new
  episodes and never replays events that occurred while disabled.
- `activeTip` anchor-death clearing (pane disposed, session deleted) lives
  in the same wiring module.

### 7. Surfaces

- **CoachChip**: one component, two anchor renderers. Pane-anchored
  (selection rescue): pane-overlay grammar per PaneResumeBanner. Sidebar
  session-pair anchored (thrash): positioned at the pair of rows, same
  visual grammar. Auto-fades after 8s. Auto-fade = **"not now"** (counts
  as a showing, no other penalty). The explicit control is labelled
  **"Don't suggest this"** (not a bare ×) = `dismissForever` + the 7-day
  global quiet. Contents: ≤ 10 words + keycap chip where applicable.
  Voice rules = the video caption rules (declarative, no adjectives).
  Never steals focus; presence-pattern in/out; reduced-motion safe;
  `--font-ui`.
- **Pane overlay arbitration**: extract the existing resume/attempt visibility
  predicates into one pure helper consumed by PaneResumeBanner,
  AttemptHintChip, and CoachChip. Priority is resume → attempt hint → coach;
  keeping one helper prevents three copies of the same eligibility rules from
  drifting. PaneSearchBar remains top-right and does not contend for this slot.
- **"For you" shelf**: new group in the Ctrl+? modal, retitled
  **"Shortcuts & tips"** (it now hosts non-keyboard advice like
  drag-to-split; keeping it in Ctrl+? because that modal is already the
  app's single self-help surface — one place to look, no new surface).
  Rows render only when shelved ∧ ¬graduated ∧ ¬dismissed: tip line +
  optional keycap + per-row "Don't suggest this". The durable session-thrash
  row is generic; only the live contextual chip names the observed pair. When
  a tip is first shelved, `shelfHasNew` drives a 2px dot on the ⌨ top-bar icon
  — at most once per 7 days via `lastShelfDotAt`, cleared through
  `markShelfOpened` when the modal opens, suppressed when `tipsEnabled` is off.

## Steps

1. coachCatalog (TIP_CATALOG + COACH_TUNING) + coachStore (persisted +
   ephemeral activeTip) + gate engine with injected clock + prefsStore
   `tipsEnabled` + Settings row + "Reset learned tips". Tests: full gate
   matrix (calendar-day + trailing-7 budget incl. midnight boundaries, no
   exemptions, quiet-after-dismissal, lifetime caps, graduation
   precedence, retro-graduation), array bounding, persistence round-trip,
   activeTip never persisted, shelf-dot 7-day cap + clear-on-open, reset keeps
   `tipsEnabled` unchanged.
2. Instrumentation seams: `noteTerminalInput` (registry input path),
   `noteSessionNavigation` (sidebar click + keyboard cycle entry points,
   split-view-open suppression). Tests: metadata-only shape; suppression
   cases (boot restore and programmatic activation emit nothing).
3. CoachChip (both anchors) + shelf group + ⌨ dot. Tests: anchor
   rendering incl. pair names from payload, slot-yield (never displaces
   banner/hint chip), auto-fade vs dismissForever semantics, anchor-death
   clears activeTip, empty shelf hides the group.
4. Detectors + graduation seams (registry pointer/copy branch,
   internalSessionDrag success line, hooksInstalled, paneSearchStore).
   Tests: each detector as a pure episode-machine on synthetic events +
   fake clock; false-positive suite — vim intentional drag WITHOUT the
   copy attempt (must not fire), plain Ctrl+C after failed drag (must not
   fire), thrash broken by a third session, thrash inside an open split
   (ignored), existing durable split group retro-graduates, scroll-then-search,
   hook event during the 30s arm window, hooks-status true suppresses while
   false shelves exactly once.
   Lifecycle: attach-after-open, reparent no-double-register, dispose
   cleanup, dwell-timer clear matrix, tips-off records nothing and cancels
   arms/timers, re-enable does not replay, HMR dispose.
5. Docs: DESIGN.md (coach grammar + push policy), CONTEXT.md glossary
   ("Tip", "Shelf", "Graduation"), README one-liner, CHANGELOG.

## Testing gates

vitest + typecheck + build green (no Rust). Manual GUI smoke: drag-select
in Claude Code, then Ctrl+Shift+C → chip on that pane; Shift+drag once →
never again. Thrash two sessions 6× in 10 min → chip at the pair, advice
preserved in Ctrl+?; drag-split them → row gone. Run `claude` with hooks
off ≥ 30s → signals row appears in the shelf (no push, ever); enable hooks
→ row gone. "Don't suggest this" on any push tip → nothing pushes for 7
days. Toggle Workflow tips off → total silence including the ⌨ dot. Verify
the chip never appears while a resume banner or attempt hint chip is up.

## Risks

- **Session-pair anchor is new layout work** (chip positioned at two
  sidebar rows that can scroll/collapse). Fallback: anchor to the sidebar
  header with both names in the copy — same message, simpler geometry.
- **Thrash threshold tuning** (6/10min is a judgment call): one knob in
  COACH_TUNING; err higher if smoke feels eager.
- **Perception risk is the product risk**: mitigated structurally — Phase
  A's entire push surface is one copy-confirmed failure rescue + one
  high-friction contextual nudge, under a global 1/day·2/week·no-exemption
  budget.

## Out of scope (Phase B+, shelf-lane candidates)

Command-intent tips (git diff → Diff tab, gh pr create → Land, claude
--resume → auto-resume), URL-copy → Ctrl+Click, sidebar filter, session
rename coaching, Key-Promoter-style generic mouse→keycap promotion, any
telemetry (everything is local, always).

## Review deltas (v1 → v2, external review 2026-07-10)

1. Session thrash promoted shelf → contextual push under a widened,
   explicit push policy (active failure OR high-confidence friction);
   pushes once at the moment of friction, preserved on the shelf after.
2. Precise-signals intro demoted push → shelf (it's promotion, not
   rescue); copy neutralized ("that dot was a guess" disparaged our own
   fallback); field name corrected to `PaneAgent.agent`.
3. Selection rescue re-based on a confirmed failure chain: failed drag +
   Ctrl+Shift+C on empty selection (the registry's existing dead branch);
   plain Ctrl+C explicitly excluded (SIGINT). Kills the vim false
   positive.
4. Ephemeral `activeTip` state added (anchor union, payload, shownAt) —
   v1 had history but nothing for CoachChip to render from. Not persisted.
5. Thrash detection moved off raw `activeSessionId` onto semantic
   `noteSessionNavigation` events; boot restore / programmatic /
   split-visible transitions excluded.
6. Graduation wired to the real success seam (`internalSessionDrag.ts:95`
   after `openSplitWith`), not transient drag-store state.
7. Budget contradiction resolved: one global rule, no rescue exemptions.
8. `noteTerminalInput` timing seam specified (no store exposed last-input
   time); clock injected for testability.
9. Listener ownership/cleanup section added (attach after `term.open()`,
   reparent-safe, dispose paths, dwell-timer clear matrix, HMR) + test
   plan rows.
10. Smaller: modal retitled "Shortcuts & tips"; auto-fade = "not now" vs
    explicit "Don't suggest this" = forever; "Reset learned tips" action;
    persisted arrays bounded; declarative TIP_CATALOG added; effort
    honestly relabeled M ("contained", not "cheap").

## Review deltas (v2 → v3, final consistency pass 2026-07-10)

1. Precise-signals shelving now confirms hooks are actually absent with the
   existing `claudeHooksStatus()` client; command identity alone no longer
   claims that hooks are off.
2. Session-pair names are ephemeral contextual payload only; the durable
   shelf row is generic, avoiding stale labels and an undefined multi-pair
   storage model.
3. Existing users with a durable split group retro-graduate immediately, so
   the coach does not teach a feature they have already demonstrated.
4. Shelf notification state (`shelfHasNew`, `lastShelfDotAt`,
   `markShelfOpened`) is now explicit and testable instead of existing only
   in surface prose.
5. Reset semantics, tips-off active-tip clearing, capture-phase non-mutating
   pointer listeners, Shift boundaries, and shared pane-overlay arbitration
   are specified.
6. Phase A count corrected to four tips; the master toggle now stops pattern
   observation/history mutation rather than merely hiding coach surfaces, and
   persisted timestamp/day representations are explicit.

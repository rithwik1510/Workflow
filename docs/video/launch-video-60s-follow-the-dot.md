# Lume launch video — "Follow the Dot" (60s master script)

**Concept:** The accent dot is the protagonist. It opens the film alone in darkness, and every beat answers "what does this dot let you do?" The film ends where the brand begins: the tumbling working-mark settles into the static Lume logo.

**Format:** ~60 seconds · captions + music (music added later by Posan) · no voiceover · 16:9 master (3840×2160 render target; safe for 1080p).

**Why this concept:** the dot IS the product thesis (attention). It needs zero competitor framing, zero foreign UI, and it is the cheapest object to animate at the highest quality — which means every second of budget goes into polish, not coverage.

---

## Global style spec

Everything on screen is the real Lume design language. No invented chrome.

| Element | Spec |
|---|---|
| Canvas | `#0a0a0a` (bg-0). True black vignette edges acceptable, no gradients on surfaces (DESIGN.md: "No gradients. No shadows" inside the app UI — the *camera* may add depth-of-field, the UI may not) |
| Accent | Cobalt `#5fa8ff` (default theme). The dot, the working mark, focus cues |
| Text in UI | Inter (UI), JetBrains Mono (terminal content) — the real bundled fonts |
| Captions | Inter, 500 weight, `#e6e6e6`, ~42px @ 4K, lower-third or centered per shot. Enter: fade+rise 12px. Exit: fade. Never two captions on screen at once |
| Motion curve | `cubic-bezier(0.16, 1, 0.3, 1)` (the app's `--ease-out`) for every enter/open. `cubic-bezier(0.4, 0, 1, 1)` for exits. One curve everywhere — this is a brand rule, not a suggestion |
| Camera | Slow push/pull only. No whip pans, no 3D tilts. The "camera" is a 2D zoom/translate over a flat UI, Linear-style |
| Cuts | Hard cuts on (future) music beats; crossfades only inside a continuous camera move |
| Terminal content | Real agent transcripts (script below). Claude Code `✻`, Codex `›/▌`, Gemini `✦` glyphs match the website mock for continuity |
| Working mark | The exact SessionRow SVG: rounded-square outline (rx 3) + 4×4 accent square tumbling clockwise inside. This is the only "spinner" that may ever appear |
| The dot | 8px circle, accent color, soft outer glow (opacity pulse 0.6→1.0, ~1.8s period). Glow animates on opacity, never box-shadow blur radius |

**Recurring sidebar cast (used in several shots):**

```
PROJECTS
▾ auth
    ◻ Session 1          ← working mark (tumbling)
    ● Session 2          ← THE DOT (unread)
    ○ Session 3          ← idle (hollow)
▾ website
    ◻ Session 1          ← working mark
```

---

## Shot list

### COLD OPEN — the dot (0:00 – 0:08)

**SHOT 1 · 0:00–0:04 · "the dot alone"**
- ON SCREEN: Pure `#0a0a0a`. After 0.5s of stillness, a single cobalt dot fades in dead center (400ms, ease-out). It pulses softly. Nothing else exists.
- MOTION: Dot scale 0.6→1.0 on entry with the ease-out curve; then the 1.8s glow pulse loop.
- CAPTION (in at 0:01.5, centered, just below the dot):
  > **This dot means Claude Code needs you.**

**SHOT 2 · 0:04–0:08 · "the dot has neighbors"**
- ON SCREEN: Camera pulls back (one continuous 3.5s move). The dot resolves into its real home: a sidebar session row — `● Session 2` under the `auth` group. As the pull continues, the rows above and below fade in: `Session 1` with the working mark tumbling, `Session 3` hollow-idle.
- MOTION: Pull-back is the ease-out curve stretched over the full shot. Sibling rows fade in staggered 120ms apart as they enter frame.
- CAPTION (in at 0:05, lower third):
  > **These mean they don't.**

### REVEAL (0:08 – 0:14)

**SHOT 3 · 0:08–0:14 · "the command center"**
- ON SCREEN: The pull-back completes into the full Lume window: TopBar, sessions sidebar (cast above), three tiled panes streaming *live* — Claude Code (left, tall), Codex (top right), Gemini (bottom right) — StatusBar reading `pwsh · ~/projects/auth` and `3 panes · 3 agents`. Text streams in all three panes simultaneously the moment the frame settles.
- TERMINAL CONTENT (looping, subtle):
  - Claude: `⏺ Update(src/auth/session.ts)` / `⎿ + import { tokenStore } from "./tokenStore"`
  - Codex: `• npm run build` / `✓ built in 3.2s`
  - Gemini: `✦ 3 files · +84 −12`
- MOTION: Streams render line-by-line (not character-typed — agents emit chunks). The window itself is perfectly still: the calm IS the message.
- CAPTION (in at 0:09, lower third, holds 3.5s — this is the title card):
  > **Lume — a command center for your coding agents.**

### BEAT 1 — run the fleet (0:14 – 0:25)

**SHOT 4 · 0:14–0:19 · "splits without seams"**
- ON SCREEN: Start from ONE full-window pane (hard cut). A keycap chip `Ctrl Alt →` taps in the lower third — the pane splits right on the beat; the new pane's shell prompt appears and `claude` is typed and launched. `Ctrl Alt ↓` — splits down, `codex` launches. One more — `gemini`. Each split is butter: both panes keep streaming through the resize.
- MOTION: Splits animate with the ease-out curve, ~380ms each, spaced ~1.4s apart (future music beats). Keycap chips fade+rise in sync with each split.
- CAPTION (in at 0:15):
  > **Claude Code. Codex. Gemini. One window.**

**SHOT 5 · 0:19–0:25 · "flood every pane"**
- ON SCREEN: All four panes (the three agents + a build pane) erupt at once — fast scrolling output everywhere. In the focused pane, a command is being typed *by the user* through the flood: `git diff --stat` — every keystroke echoes instantly. Push-in slightly on the typed line.
- MOTION: Scroll speed high but legible; the typed line is the only "slow" element — that contrast is the shot.
- CAPTION (in at 0:20):
  > **Flood every pane. Typing still lands first.**
- CAPTION 2 (in at 0:23, small, mono, fades quickly — the receipts):
  > `<30ms keystroke · 32ms IPC batch · WebGL`

### BEAT 2 — read what they write (0:25 – 0:33)

**SHOT 6 · 0:25–0:33 · "the plan, beside the work"**
- ON SCREEN: In the Claude pane, the agent prints: `⏺ Wrote docs/PLAN.md`. The path renders as a link (underline on hover). Cursor moves to it, `Ctrl` keycap chip appears, click — the Quick Viewer panel docks from the right (25% width, ease-out) with PLAN.md *rendered*: headings, checklist, a code block. While the viewer is open, the agents on the left keep streaming.
- MOTION: Panel dock 420ms ease-out. The markdown content fades in top-to-bottom with a 60ms stagger per block. A checklist item gets checked as the agent works (one subtle live update).
- CAPTION (in at 0:27):
  > **Read what they write.**
- CAPTION 2 (in at 0:30):
  > **Ctrl+Click any `.md` an agent mentions.**

### BEAT 3 — the dot pays off (0:33 – 0:45)

**SHOT 7 · 0:33–0:39 · "switch away, Lume keeps watch"**
- ON SCREEN: User clicks a *different* session in the sidebar (`website · Session 1`) — the whole center swaps to that session's panes (instant, no flicker). Camera then drifts toward the sidebar and holds there. In the background rows: the `auth` sessions' working marks tumble… then one mark stops and flips to **the dot** (with its soft ping-in: scale 1.4→1.0). A second later, another row's dot lands.
- MOTION: The mark→dot transition is THE money frame of the film: mark's tumble decelerates over 300ms, outline fades, dot pings in. Treat it like a logo reveal.
- CAPTION (in at 0:34):
  > **Switch away. Lume keeps watch.**
- CAPTION 2 (in at 0:37, timed to the first dot landing):
  > **Done means a dot. Working means it isn't.**

**SHOT 8 · 0:39–0:45 · "come back to finished work"**
- ON SCREEN: Click the dotted row. Instant swap back: the Claude pane shows the finished turn — a completed diff summary and the agent's question waiting at its input box. The dot in the sidebar clears the moment the session activates.
- MOTION: Session swap <100ms (it really is — sell that). Small push-in on the agent's waiting question.
- CAPTION (in at 0:41):
  > **No tab-cycling. No guessing. No babysitting.**

### BEAT 4 — close it. all of it. (0:45 – 0:53)

**SHOT 9 · 0:45–0:53 · "the fleet comes back"**
- ON SCREEN: Mid-stream — agents working — the cursor goes to the window ✕ and *closes Lume*. Black. One full second of darkness and silence (the only stop in the film). Then the window reopens: the sidebar repopulates, every session revives, panes respawn, and in the focused pane `claude` is typed *by itself* at the prompt and relaunches. The working marks resume tumbling one by one.
- MOTION: Close is a hard cut to black (with a 200ms window-scale-down). Reopen uses the app's real launch sequence; the auto-typed command should look exactly like the real feature (types only after the prompt is ready).
- CAPTION (in at 0:46, ON the black):
  > **Close it. Mid-task.**
- CAPTION 2 (in at 0:49, as sessions revive):
  > **Reopen — the whole fleet comes back.**

### CLOSE — brand (0:53 – 1:00)

**SHOT 10 · 0:53–1:00 · "the mark settles"**
- ON SCREEN: Camera pushes back toward the sidebar one last time — the working marks finish, each flipping to a quiet dot, the dots fade to hollow. Crossfade: a single working mark, large and centered on black, tumbles twice more and *settles* — the accent square comes to rest in the top-left cell: the static Lume logo. Wordmark "Lume" fades in beside it.
- MOTION: The settle is two decelerating tumbles, ease-out, ending in perfect logo geometry. Hold 1s.
- CAPTION (in at 0:56, below the logo, two lines):
  > **Stop babysitting your agents.**
  > `lume-gold-pi.vercel.app · free · open source · Windows`

*(end card holds until 1:00; music resolves here when added)*

---

## Caption copy — full list (for review in one place)

1. This dot means Claude Code needs you.
2. These mean they don't.
3. Lume — a command center for your coding agents.
4. Claude Code. Codex. Gemini. One window.
5. Flood every pane. Typing still lands first.
6. `<30ms keystroke · 32ms IPC batch · WebGL`
7. Read what they write.
8. Ctrl+Click any `.md` an agent mentions.
9. Switch away. Lume keeps watch.
10. Done means a dot. Working means it isn't.
11. No tab-cycling. No guessing. No babysitting.
12. Close it. Mid-task.
13. Reopen — the whole fleet comes back.
14. Stop babysitting your agents.

Voice check: every line is declarative, ≤8 words where possible, no adjectives doing the selling — the screen does.

---

## Scene/asset inventory (for the Claude-design build)

| Asset | Used in shots | Notes |
|---|---|---|
| The dot (glow pulse loop) | 1, 2, 7, 8, 10 | One component, reused everywhere |
| Working mark (tumble loop + settle variant) | 2, 3, 7, 9, 10 | Exact SessionRow SVG geometry |
| Mark→dot transition | 7, 10 | The signature animation — build first, polish most |
| Sessions sidebar (cast layout) | 2, 3, 7, 8, 9, 10 | One layout, state-swapped |
| Full window frame (TopBar/StatusBar) | 3–9 | Static chrome, real iconography |
| Terminal pane w/ streaming text | 3, 4, 5, 8, 9 | Line-chunk streaming, three agent "voices" |
| Split animation | 4 | Real ease/duration from the app |
| Quick Viewer dock + rendered PLAN.md | 6 | Real markdown styles (headings/checklist/code) |
| Keycap chip component | 4, 6 | `Ctrl Alt →` style |
| Logo settle + wordmark | 10 | End card |

## Craft rules (what keeps it Anthropic-grade)

1. **One idea per shot.** If a shot needs two captions, the second must be a footnote (smaller, mono), never a second idea.
2. **The UI never lies.** Every animation duration/curve matches the shipped app. If the app can't do it, the video doesn't show it.
3. **Stillness is the luxury.** Between beats, let the frame breathe 300–500ms with nothing moving except agent streams.
4. **The dot is sacred.** Nothing else on screen may pulse, glow, or use the accent at full saturation while the dot is making its point.
5. **No mouse trails, no fake cursors flying.** Cursor moves are short, purposeful, mostly cut-implied.

## Known honesty constraints (respected by this script)

- Fleet restore revives sessions and relaunches the *command* — it does not resume mid-task agent state. Shot 9's captions say "comes back," never "resumes."
- Attention's OSC-133 precision is PowerShell-family; the script shows pwsh sessions throughout.
- Windows-only: end card says Windows; no mac chrome anywhere.

## Open items

- [ ] End-card URL: confirm `lume-gold-pi.vercel.app` is the URL to print, or a nicer domain lands first.
- [ ] Website nav chip still says `v0.1-alpha` — fix before the video drives traffic.
- [ ] 30s social cut (optional later): Shots 1-2-3 + 7 + 10 survive almost unedited.

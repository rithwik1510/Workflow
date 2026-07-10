# Lume — Product Direction & Competitive Brainstorm

**Date:** 2026-07-07
**Author:** Claude (with Posan), a deep-dive brainstorm session
**Status:** Thinking doc — decisions NOT yet locked. Ends with an open fork to pick from.

> Purpose: ground the next roadmap cycle in (a) our own goals, (b) an independent
> brainstorm across performance / core wedge / nice-to-haves / ahead-of-curve, and
> (c) fresh competitor research. Written to be re-read later.

---

## 0. The yardstick (how every idea below was filtered)

Three things already locked, used as the test for every idea:

1. **The thesis** — *"Which of my N agents needs me right now?"* answered without
   clicking into each pane. The dot is the wedge; the **fleet dashboard is the 10x**
   (per CEO-REVIEW.md: "an agent operating system for solo developers").
2. **The boundary** — build *around* agents (environment, attention, workspace,
   review, reach). Never touch, steer, queue, or optimize the agent itself.
   *(See §8 — research shows this is now the field norm, not a differentiator.)*
3. **The proof point** — smoothness. It doesn't tear under load (the 2am test).

**Central observation:** we've built the wedge (per-session dots) but not the 10x
(the fleet view). The product today makes you think *per pane*; the thesis is
fundamentally *cross-pane*. That gap is where the biggest ideas live.

---

## 1. Independent brainstorm — ideas in all directions

### Direction 1 — The Fleet Dashboard (the missing centerpiece)
A **triage surface**, not a list of panes:
- A card per agent across all tabs/sessions, **sorted by who-needs-me-most**
  (blocked-on-permission → your-move → working → idle).
- Each card: agent glyph + name, **current state with a "since" timer**
  ("blocked 4m", "working 12m", "done 2m ago"), branch, **diff summary** (+142 −30, 6 files).
- **Click-to-jump** into the pane; `Esc` back to the fleet.
- Pure observation — dead on-boundary.
- **Why it compounds:** the dots earned trust in Lume's read of state; the dashboard
  turns that trust into leverage — you run *more* agents because you can hold them all
  in your head at once. That's the real 10x.

### Direction 2 — Triage as a verb (attention's next layer) ★ sharpest wedge
The dots are a *display*; make attention **actionable**:
- **"Next agent that needs me" hotkey** — cycle through the needs-you queue,
  most-urgent first. Inbox-zero for your fleet. Likely the highest-leverage *small* feature.
- **"Since" timers everywhere** — "blocked 8m" feels very different from "blocked 20s".
- **Welcome-back digest** — on return: *"While you were gone: A finished (12 files),
  B blocked on permission 6m ago, C went idle."* The emotional payoff of "walk away".
- **Focus / Do-Not-Disturb window** — batch OS-escape signals during deep work.

### Direction 3 — Reach: the fleet in your pocket
- **Read-only mobile/web view of fleet dot-states**, served by the desktop app over the
  user's own network/tunnel. "3 done, 1 blocked, 2 working."
- Strictly observe-only (no driving from phone = on-boundary + dodges a security minefield).
- *Caveat from research:* the mobile-companion lane is getting crowded (AgentsRoom,
  Nimbalyst, CliDeck, Factory, Devin, Async). Still valuable for reach, but not whitespace.

### Direction 4 — Review & artifacts (around: output)
- **Exit-code capture per pane** (we already have OSC 133 lifecycle) → green/red on each
  session's last command. "Agent B's tests are red" at a glance.
- **Fleet-level review flow** — review every agent's diff in one sweep, land in sequence.
  (Diff tab is per-attempt today; the missing piece is the *cross-agent* review queue.)
- **Artifact surfacing** — localhost URL printed, file written, build finished → glanceable event.
- **"Changed since I last looked"** markers in diffs.

### Direction 5 — Workspace plumbing (around: environment)
- **Project profiles / workspace templates** — open a repo → one action spawns the standard
  rig (claude here, codex there, plan.md open). Pairs with "configurable per-pane shells" (roadmap).
- **Saved layouts** as first-class presets.
- **Worktree/attempt panel** — extend today's branch switcher into a board of all attempts
  (branch, diff size, land status). Natural next pull after the branch-list cleanup.

### Direction 6 — Performance (explicitly asked)
- **Render governor Phase 2 (Rust-side)** — deferred in plans/007. Lets the fleet scale past
  ~8 panes gracefully. Sequence right behind the dashboard (bigger fleets = load-bearing).
- **Perf HUD (opt-in)** — live typing-latency + IPC-lag readout. Diagnostics *and* marketing
  you can see; the 2am claim made visible. On-brand.
- **Restore-at-scale** — cold-start + session-restore cost with 8+ sessions (and OneDrive
  hydration, which already bit us) deserves a measured pass.
- **Background eviction tuning** — ring-buffer + WebGL-pool behavior when the fleet is large & idle.

### Direction 7 — Ahead of the curve (the bet)
Our own boundary note: *loops will be the norm within a year.* Lean in — **Lume is the
command center for long-running autonomous agents.** The longer agents run unattended, the
more valuable "which one needs me" becomes.
- **Per-agent timeline / history** — a passive strip of state transitions
  (worked 8m → blocked → you approved → worked 14m → done). "What happened while I was away."
- **Cross-machine identity** (CEO doc) — the workstation as a portable thing. Long-term endgame.

### Explicitly NOT chasing (for now)
Anything that reaches *into* the agent; light mode; plugin API; session replay
(all already parked, correctly).

### My sequencing recommendation (pre-research)
Spine: **Fleet Dashboard → "next agent that needs me" triage → welcome-back digest →
remote glance.** One coherent story, each ships independently, all on-boundary.
Performance (governor P2) rides right behind.

---

## 2. Competitive Landscape — Multi-Agent Coding Command Centers (2025–2026)

> Fresh web research, July 2026.

### The single most important structural shift
**Claude Code now ships native Notification hooks** (`agent_needs_input` /
`agent_completed`, v2.1.198+) plus an official **Agent View** for tracking multiple sessions.
This standardizes the exact OS-level primitive Lume's attention dot relies on.
**Per-agent state signaling is no longer a moat by itself.** Our edge must be the
*quality/precision* of the state model and the *"jump to who needs you" triage flow* —
not merely having a status light.

### Who does fleet-at-a-glance state — and HOW

| Tool | State model | Mechanism | Notes |
|---|---|---|---|
| **Warp** | working / waiting / idle / done | Status badges on vertical tabs + fleet management UI; in-app + system notify | **Closest published match to Lume's exact taxonomy.** Cross-platform. Apr 2026 added universal CLI-agent support. The one to out-execute. |
| **AgentsRoom** | green=active / blue=done / amber=waiting / red=error | Color-coded cards on Claude Code hook events | **Nearest GUI competitor on the attention-dot concept.** Electron + xterm.js, +iOS/Android. |
| **Paneflow** | thinking / waiting / stalled / failed / done | Per-pane state + read-only MCP control plane (agent-to-agent) | Rust/GPUI. **Abandoned Tauri** — claims webview can't handle low-level input/IME/inter-pane focus. |
| **Herdr** | blocked / idle / working | Sidebar list, tmux-style | Rust/Ratatui TUI; attention is its headline. |
| **ccmanager** | Waiting / Busy / Idle | Per-session indicators + status-change hooks → desktop notify | MIT TUI; built to fix Claude Squad's attention gap. |
| **cmux** | needs-attention (binary) | Blue ring + tab light + notify via OSC 9/99/777 + `cmux notify` | 23.8k★ native Mac. Shows git branch/PR/ports per tab. |
| **brizz-code** | churning / finished / blocked-waiting | **Space = jump to next agent needing attention**, `Y` approves | Go/Bubble Tea TUI. Tightest expression of Lume's "jump to who needs you". |
| **Conductor** | needs-input (binary) | Chat-tab icon change + notifications | Mac-only, free. Shares "around" philosophy; binary, not rich. |
| **CliDeck** | working / waiting | Chat sidebar + browser/sound notify | Local app + browser/mobile. |
| **agent-farm** | working/idle/error/disabled + context% + heartbeat | Ops-monitoring dashboard | Richest telemetry but ops-monitoring, not human triage. |
| **Codex app** | active / done / approval-pending | Per-thread indicators + notify | No unified cross-thread fleet dashboard. |
| **Zed** | unnamed status dot per thread | Threads sidebar by project | Taxonomy unspecified; no push. |
| **Cursor 2.0** | none documented | Agents/plans sidebar only | Loudest on parallelism (8 agents), **quietest on attention** — clearest whitespace among majors. |

**No real attention layer** (parallelism + PR handoff only): Superset, Emdash, Devin,
Factory, Sculptor, Terragon, Async, Jules, Copilot cloud agent, Vibe Kanban.

### Features becoming table-stakes
- **Git-worktree-per-agent isolation** — universal (containers the alternative).
- **Agent-agnostic hosting** (Claude Code + Codex + Gemini + OpenCode) — now expected.
- **Inline diff review + one-click branch/commit/PR.**
- **BYO-key, no markup pricing.**
- **Desktop notifications on completion.**
- **Mobile companion** (lane getting crowded).
- **Hook/escape-sequence state detection** — now including native Claude Code hooks (matches plans/008).

### Genuinely novel / differentiated
- **Sculptor Pairing Mode** — bidirectional sync of a container agent's work into your local
  repo (best "into-the-loop without prompt-queuing" design).
- **Paneflow read-only MCP control plane** — an agent can read another pane's test output/errors.
- **Devin Managed Devins** — manager decomposes work, spawns child Devins, resolves conflicts.
- **Cursor 2.0 fan-out** — 8 agents attempt same prompt, pick best.
- **brizz-code "Space = next agent needing attention"** — keyboard-native triage.
- **cmux/AgentsRoom scriptable browser pane** — agents test their own web work in-app.
- **agent-farm lock-based file coordination + auto-recovery** — 50 agents, no collisions.
- **Factory Custom Droids** — subagents as markdown+YAML files.

### Gaps NOBODY serves well (whitespace for Lume)
1. **Precise, low-false-positive attention across a large fleet** + **ranked triage.**
   Everyone nails "done → PR"; almost no one ranks 10 running agents by who needs a human
   first. brizz-code's "jump to next" is the only real triage flow, and it's a TUI.
   **This is Lume's sharpest wedge — depth of state model + ranked triage, not just a dot.**
2. **Windows-first polish.** Most rivals are macOS-first or TUI. (cc-pane & Codex app are the
   main cross-platform GUI exceptions.)
3. **A genuinely good markdown editor + file sidebar inside the command center.**
4. **Idle vs working distinction** — rare (only Warp, ccmanager, Herdr, Paneflow, AgentsRoom).

### Where the puck is heading in 2026
- **Big vendors entering GUI command-center space:** GitHub Copilot App (GA Jun 17 2026,
  standalone desktop, parallel worktree agents), OpenAI Codex app, Warp. The indie window is
  closing on generic "run N agents in parallel."
- **YC funding this category:** Emdash (W26), Zenbu (W26), Superset (9.2k★, #1 Product of the
  Day Feb 2026). Momentum + capital concentrating.
- **Attention/state signaling is commoditizing** via native hooks — differentiation moves
  up-stack to triage UX, precision, workflow.
- **Graveyard (caution about Lume's shape):** Terragon (shut Feb 2026), Crystal (deprecated →
  Nimbalyst), Vibe Kanban (cloud shut Apr 2026, 27.3k★), sketch.dev (retired → Shelley),
  Opcode (abandoned). Kanban-metaphor and pure-desktop-GUI approaches are proving hard to sustain.
- **Field consolidating around "around, not inside"** — nearly all GUI tools host CLIs and
  send follow-up prompts. **Lume's boundary matches the field norm rather than distinguishing it.**

### Direct competitors to watch, ranked
1. **cc-pane** (github.com/wuxiran/cc-pane) — **architectural doppelgänger**: Tauri 2 +
   React 19 + Rust + xterm.js + portable-pty + SQLite + Monaco + git + local history diff +
   notifications. 482★, v0.10.7 (Jul 6 2026). Most feature-overlapping product in existence —
   study closely.
2. **Warp** — only major with the exact working/waiting/idle/done taxonomy + fleet UI +
   universal CLI-agent support. Cross-platform. Best-funded direct threat on the attention thesis.
3. **AgentsRoom** — nearest GUI competitor on the attention-*dot color model*.
4. **Paneflow** — same shape, richer state model + MCP coordination; note Tauri-abandonment warning.
5. **Herdr / brizz-code / CliDeck** — attention-flow competitors (TUI/hybrid).
6. **Superset / Emdash** — momentum + YC funding, weak attention layer (our opening).

---

## 3. Sharpened thesis (post-research)

> Not *"Lume shows you agent state."* Everyone does now.
> **"Lume is the fastest way to triage a fleet — it ranks who needs you and takes you straight there."**

What the research corrects/confirms:
- **The dot is table-stakes; the triage is the moat.** Ranked "who needs me first" +
  jump-to-next is the flow the whole field is missing (only brizz-code, a TUI). → promotes
  Direction 2 from "nice layer" to **the wedge**.
- **"Around, never inside" is the field norm, not a positioning wedge.** Keep it as design
  discipline; stop leading positioning with it.
- **Defensible whitespace = Windows-first polish + a real markdown/editor/file surface.**
- **Don't try to out-parallelize the giants** (Copilot App, Codex, Warp). Win on attention
  triage precision + the Windows + editor base they lack. Ship fast; the indie window is closing.
- **Pressure-test Paneflow's claim** (webview can't carry a serious multiplexer: input/IME/
  inter-pane focus) against our Tauri build before scaling the fleet.

### Recommended focus (my pick)
Make the attention system **actionable** first — ranked triage + jump-to-next + "since"
timers — the cheapest, sharpest opening, building on trust the dots already earned. The
**Fleet Dashboard** remains the 10x centerpiece right behind it. **Performance (governor P2)**
rides behind that.

---

## 4. Open fork — pick one to take deep next

_(Presented via AskUserQuestion on 2026-07-07; deferred in favor of saving this doc.)_

1. **Triage flow (recommended)** — rank agents by who-needs-you-first, a "jump to next agent
   needing you" hotkey, "since" timers. Small-to-medium; sharpest competitive opening.
2. **Fleet dashboard** — the 10x cross-pane triage surface (cards, states, diff summaries,
   click-to-jump). Bigger build; strategic flagship.
3. **Audit cc-pane first** — deep-dive the near-clone + Warp's fleet UI before committing
   roadmap, so we differentiate deliberately. Research action; de-risks the next cycle.
4. **Performance (governor P2)** — Rust-side render governor (plans/007) so the fleet scales
   past ~8 panes. Foundational once triage/dashboard drives bigger fleets.

---

## 5. Homework / open threads to not forget
- **Audit cc-pane** (feature-by-feature) — our closest clone; differentiate on purpose.
- **Benchmark triage UX** against brizz-code (keyboard triage) + Warp (fleet UI).
- **IME / inter-pane focus edge testing** — pressure-test Paneflow's Tauri-abandonment claim.
- **Re-read** alongside: CEO-REVIEW.md (10x vision), DESIGN.md (v0.3 Dashboard + Ctrl+K
  Spotlight), plans/007 (render governor), plans/008 (agent-state detection).

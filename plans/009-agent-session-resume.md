# Plan 009: Agent session resume (workspace restore, never steering)

## Status

APPROVED — operator-directed 2026-07-02. Design locked the same day:
**banner with explicit [Resume] button for everyone (default)** + **opt-in
"auto-resume on restore" setting for power users**. The pre-fill-without-
executing variant was considered and dropped by the operator.

Depends on Plan 008's infrastructure (agent identity + hook events) being
merged. Execution: worktree branch per repo convention; reviewed before merge.

## Goal

Today, restarting Lume (update, reboot, crash) brings sessions and layout
back, but every pane is a fresh shell. The operator then re-types `claude` /
`codex` and manually resumes each conversation. Automate the round-trip:

1. A pane that was running an agent when the app closed shows a slim banner
   on restore: `✻ Claude was running here — [Resume] [Just shell]`.
2. `[Resume]` writes the exact resume command to the pty (user-visible,
   auditable — it appears in the terminal like anything they'd type).
3. With **Settings → "Auto-resume agents on restore"** ON (default OFF), the
   resume command is written automatically once the shell is ready.

**Product boundary (lume-product-boundary):** this restores what the user
launched — it never composes prompts, never speaks to a running agent, and
never runs anything the banner didn't display verbatim.

## Why this is exact (data we already have)

| Fact needed | Already available from |
|---|---|
| Which agent ran in the pane | `agentIdentity.agentFromCommand` (Plan 008) + hook `SessionStart` |
| The agent's own session id | hook payloads → `agentTracker` keeps `sessionId` per pane |
| The pane's working directory | `ptyStore` per-pane `cwd` (OSC-fed), fallback session project path |
| The launch command as typed | command-detection path that feeds `noteCommandAgent` |
| Was it alive at shutdown? | absence of `SessionEnd` for that pane before app close |

So resume is **by exact session id** for Claude (`claude --resume <id>`),
not "whatever was most recent in this folder".

## Resume-command adapter table

One tiny per-agent mapping, kept in `src/sessions/agentResume.ts`:

| Agent | With session id | Without id | Notes |
|---|---|---|---|
| claude | `claude --resume <id>` | `claude --continue` | id comes from hook events; `--continue` = most recent in cwd |
| codex | `codex resume <id>` | `codex resume --last` | no id until the Codex hook adapter (008 phase 3) — use `--last` |
| gemini | — | re-offer original launch command | verify resume support at implementation time; command-refill is the safe floor |
| unknown | — | re-offer original launch command | never auto-resumed |

Flags from the original launch (e.g. `--model opus`) are shown in the banner
tooltip but NOT merged into the resume command in v1 — resume restores the
conversation, which carries its own model/config. Revisit only if the
operator hits a real case.

## Architecture

```
agent events (008) + command detection ──▶ paneResume record (persisted)
        { agent, launchCommand, agentSessionId, cwd, aliveAtShutdown, lastSeenAt }
                                   │  app restart → session/layout restore
                                   ▼
             TerminalPane overlay banner  ──[Resume]──▶ pty write "<cmd>\r"
                                   │
             settings.autoResumeAgents ──▶ orchestrator writes it after
                                           shell readiness (Plan 006 gating)
```

- **Store:** new persisted slice (own store `paneResumeStore`, mirroring how
  Plan 008 kept `agentStore` separate) — NOT crammed into `sessionsStore`.
  Records are written on agent `SessionStart` (id + cwd), on command
  detection (launch command), and cleared/marked by `SessionEnd`.
- **`aliveAtShutdown`:** a record whose pane never received `SessionEnd`
  before the app closed. Banner shows for any record; **auto-resume fires
  only for `aliveAtShutdown` panes** — if the user deliberately quit the
  agent, Lume doesn't silently bring it back.
- **Record lifecycle:** cleared when the user runs a different command in
  that pane, when `[Just shell]` is clicked, or when the pane is closed by
  the user (NOT by app shutdown — that's the case we exist for).
- **Auto-resume sequencing:** reuse Plan 006's readiness-gated sequential
  revive — resume writes join the same queue so 8 auto-resuming panes don't
  recreate the revive stampede. Skip auto-resume when the recorded `cwd` no
  longer exists (banner still shows, with a "folder missing" hint).

## Steps

1. `paneResumeStore` (persisted via `tauriPersistStorage`) + record
   plumbing from `agentTracker` / command detection. Unit tests.
2. `agentResume.ts` adapter table + `resumeCommandFor(record)`. Unit tests
   cover every row incl. unknown-agent floor.
3. Banner UI: slim overlay chip in the terminal pane (matches toast/banner
   styling), agent glyph + name, `[Resume]` `[Just shell]`, tooltip = exact
   command. Vitest component tests.
4. Settings toggle "Auto-resume agents on restore" (default OFF) in
   `settingsStore` + SettingsModal row.
5. Auto-resume path through the Plan 006 revive orchestrator, gated on
   `aliveAtShutdown` + cwd-exists + agent≠unknown.
6. Docs: DESIGN.md section + README feature bullet.

## Testing gates

- vitest: store lifecycle (record → shutdown → restore → clear), adapter
  table, banner render states, auto-resume gating matrix.
- NEVER touch the real `~/.claude`; no live agent needed for unit tests.
- Manual GUI gate (operator): restart with a live Claude session → banner;
  toggle auto-resume → fleet stands back up; `[Just shell]` clears.

## Risks / edge cases

- **Stale agent session** (CLI's own session file pruned): the resume
  command simply errors or opens the CLI's picker in the terminal — visible,
  recoverable, no Lume handling needed in v1.
- **cwd moved/deleted:** skip auto-resume; banner explains.
- **Shell readiness:** writing before the prompt is up types into nothing —
  hence the 006 readiness gate, not a timer.
- **WSL panes:** resume command runs in the same shell the user had; the
  record stores the command as typed, so `wsl`-wrapped launches re-offer
  the original command (unknown-agent floor) until proven exact.

## Out of scope

Scrollback restore (xterm serialize addon — separate later plan), Codex/
Gemini hook adapters (008 phase 3), OS notifications.

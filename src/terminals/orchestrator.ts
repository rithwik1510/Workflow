// PTY orchestrator — drives PTY lifecycle from sessionsStore changes.
// Per DESIGN.md §4 rule #2 + Weekend 0 addendum: lifecycle is keyed by
// paneId, NOT by React mount/unmount. This module is the single source.
//
// Flow (session-manager-aware as of Phase 1):
//   sessionsStore active-session set changes (status flips or layout edits)
//     → getActivePaneIds(state) gives the union of paneIds across every
//       session with status === "active"
//     → orchestrator diffs added/removed ids against the previous union
//     → calls openPty / killPty
//     → wires the per-pane Channel into:
//          - registry.writeToTerminal(bytes) for Data events
//          - ptyStore.markActivity(paneId) for throttled metadata
//          - ptyStore.setStatus(paneId, "exited"|"errored", ...) for lifecycle
//
// PTY event listeners register once at app mount (rule #9): the listener
// is the per-pane Channel.onmessage handler, set up at openPty time.

import { Channel } from "@tauri-apps/api/core";

import {
  useSessionsStore,
  getActivePaneIds,
  findSessionForPane,
  paneLaunchSpec,
} from "@/store/sessionsStore";
import { usePtyStore } from "@/store/ptyStore";
import { makeCommandCapture } from "@/lib/commandCapture";
import {
  getOrCreateTerminal,
  resetMouseModes,
  onTerminalData,
  disposeTerminal,
  fitTerminal,
} from "@/terminals/registry";
import { ingest, forget as forgetRenderSink } from "@/terminals/renderSink";
import { openPty, writePty, killPty, isAppError } from "@/terminals/ptyClient";
import { detectShells, configIdMatchesShell } from "@/lib/shellsClient";
import { noteOutput, forgetPane, disposeAttentionTracker } from "@/sessions/attentionTracker";
import { forgetPaneAgent, notePaneLaunch } from "@/sessions/agentTracker";
import { agentFromCommand } from "@/sessions/agentIdentity";
import { onCommandEvent, paneCommandState } from "@/sessions/commandTracker";
import { useSettingsStore } from "@/store/settingsStore";
import { usePaneResumeStore, type ResumeRecord } from "@/store/paneResumeStore";
import { resumeCommandFor, isAutoResumable, shouldAutoResume } from "@/sessions/agentResume";
import { dirExists } from "@/lib/fsClient";
import { formatAppError, type PaneId, type PtyEvent, type Shell } from "@/types";

/**
 * Module-level cache of shells discovered at boot. Populated by the
 * `detectShells` call kicked off inside `installPtyOrchestrator`. Empty until
 * the promise resolves; the right-click menu will simply have no shell options
 * until then. See DESIGN.md §12 W3 #8.
 */
let detectedShells: Shell[] = [];

export function getDetectedShells(): Shell[] {
  return detectedShells;
}

export async function changeShell(paneId: PaneId, shell: Shell): Promise<void> {
  // Tear down existing PTY then re-spawn with the new shell. The xterm
  // Terminal stays alive in the registry (so scrollback is preserved
  // through the swap — the new PTY's first bytes append after the old
  // content). Caller is responsible for not interleaving shell swaps
  // for the same paneId.
  await killPty(paneId).catch(() => undefined);
  // The new shell may not speak OSC 133 even if the old one did (and vice
  // versa) — reset the pane's attention/command-tracker state so detection
  // starts fresh. Also drop any pending autorun: the remembered command was
  // meant for the OLD shell, not whatever the user just switched to.
  cancelStartupAutorun(paneId);
  forgetPane(paneId);
  forgetPaneAgent(paneId);
  await spawnPane(paneId, shell);
}

interface PaneRuntime {
  /** Disposer for the xterm onData handler — closes the JS→PTY input wire. */
  inputDisposer: { dispose(): void };
}

const runtimes = new Map<PaneId, PaneRuntime>();

/**
 * Default shell for a freshly-spawned pane. Prefers the shell configured
 * in config.toml's `default_shell` key, matched against the detected shells.
 * Falls back to Windows PowerShell if the configured shell isn't detected
 * or detection hasn't completed yet.
 */
function defaultShell(): Shell {
  const configured = useSettingsStore.getState().config.default_shell;
  const match = detectedShells.find((s) => configIdMatchesShell(configured, s));
  if (match) return match;
  // Fallback: Windows PowerShell — universally available on Windows.
  return { kind: "powershell", path: "powershell.exe" };
}

export async function spawnPane(
  paneId: PaneId,
  shell: Shell
): Promise<void> {
  // Idempotency: if a runtime already exists for this pane (changeShell, or the
  // boot sweep), dispose its input wire before creating a new one. Otherwise two
  // onData handlers attach to the same Terminal and every keystroke double-sends.
  const prevRuntime = runtimes.get(paneId);
  if (prevRuntime) {
    prevRuntime.inputDisposer.dispose();
    runtimes.delete(paneId);
  }

  // Resolve the owning session's folder so the shell starts there instead of
  // the app's cwd. By the time the orchestrator fires spawnPane, the paneId is
  // already a leaf in some active session's layoutRoot, so findSessionForPane
  // resolves it. undefined → Rust inherits the default cwd. A stale/deleted
  // path is ignored server-side (pty_open guards on is_dir).
  const session = findSessionForPane(useSessionsStore.getState(), paneId);
  const cwd = session?.folderPath;
  // Diagnostic: shows in DevTools what folder we resolved for this pane.
  console.info(`[pty] spawn ${paneId} cwd=${cwd ?? "(none)"}`);

  // Remember the resolved shell on the pane's layout leaf so a reopened session
  // revives with the real shell instead of the global default (feature B).
  if (session) useSessionsStore.getState().setPaneShell(session.id, paneId, shell);

  // 1. Create/get the Terminal in the registry. Doesn't open into a DOM
  //    container yet — the TerminalPane component handles attach().
  const term = getOrCreateTerminal(paneId);

  // 2. Defensive: clear any leftover mouse modes from a prior session.
  resetMouseModes(paneId);

  // Command memory (feature B): remember the command to re-run on restore.
  // LATEST-at-prompt wins, replacing whatever was remembered before — the
  // memory tracks what the user most recently launched here, not the first
  // thing they ever typed. Scoping rules:
  //   - 133-integrated pane at its PROMPT → capture the line; on Enter it
  //     replaces the remembered command and the capture re-arms for the next
  //     prompt. Keystrokes while a command runs (answers typed INTO claude)
  //     are never fed — they're input to the agent, not a launch command.
  //   - Non-integrated pane ("none", cmd/WSL) → no prompt signal, so we keep
  //     the old conservative single-shot: capture the first command only if
  //     nothing is remembered yet (re-arming here would let TUI keystrokes
  //     overwrite the memory).
  // Autorun itself writes via writePty, not this wire — replaying a command
  // never re-captures it.
  let capture = makeCommandCapture();

  // 3. Register the input wire BEFORE opening the PTY. If the user is fast
  //    enough to type before pty_open resolves we just enqueue invokes.
  const inputDisposer = onTerminalData(paneId, (data) => {
    const cmdState = paneCommandState(paneId);
    const remembered = paneLaunchSpec(useSessionsStore.getState(), paneId)?.startupCommand;
    if (cmdState === "prompt" || (cmdState === "none" && !remembered)) {
      const line = capture.feed(data);
      if (line !== null) {
        if (line !== "") {
          const state = useSessionsStore.getState();
          const session = findSessionForPane(state, paneId);
          if (session) state.setPaneStartupCommand(session.id, paneId, line);
          // Agent identity glyph (Plan 008) + resume memory (Plan 009) in one
          // note. If the typed line launches something ELSE, the user has moved
          // on — drop any stale resume record (typed lines only: programmatic
          // replays never clear, they can only be agent launches).
          if (agentFromCommand(line)) {
            notePaneLaunch(paneId, line, session?.folderPath ?? null);
          } else {
            usePaneResumeStore.getState().clearRecord(paneId);
          }
        }
        capture = makeCommandCapture(); // re-arm for the next prompt line
      }
    }
    void writePty(paneId, data).catch((e) => {
      const msg = isAppError(e) ? formatAppError(e) : String(e);
      term.write(`\r\n\x1b[31m[pty_write failed: ${msg}]\x1b[0m\r\n`);
    });
  });
  runtimes.set(paneId, { inputDisposer });

  // 4. Pre-allocate the metadata record so the UI can render the pane shell
  //    while the spawn races.
  usePtyStore.getState().addPane(paneId, shell);

  // NOTE: spawnPane itself never types the remembered command — blind replay
  // raced PSReadLine's init and froze the prompt (desynced buffer, dead
  // backspace). Replay on revive is handled by armStartupAutorun, which waits
  // for the shell's own OSC 133;B prompt-ready mark before writing.

  // 5. Open the PTY. The Channel is created here and wires Rust → xterm.
  //    Terminal data arrives as raw bytes (InvokeResponseBody::Raw → an
  //    ArrayBuffer) — NEVER JSON (DESIGN.md §4). Exit/Error control events
  //    still arrive as parsed JSON objects.
  const channel = new Channel<ArrayBuffer | PtyEvent>();
  channel.onmessage = (msg) => {
    // Terminal data arrives as raw bytes (InvokeResponseBody::Raw) — no JSON.
    if (msg instanceof ArrayBuffer || ArrayBuffer.isView(msg)) {
      const bytes =
        msg instanceof ArrayBuffer
          ? new Uint8Array(msg)
          : new Uint8Array(
              (msg as ArrayBufferView).buffer,
              (msg as ArrayBufferView).byteOffset,
              (msg as ArrayBufferView).byteLength
            );
      // PTY bytes NEVER touch Zustand. Route through the render sink: a visible
      // pane goes straight to xterm; a backgrounded pane is buffered (drop-oldest)
      // and replayed on foreground, so off-screen sessions don't burn the main
      // thread parsing output you can't see.
      ingest(paneId, bytes);
      // Cheap throttled metadata bump for the UI's "active pane" indicator.
      usePtyStore.getState().markActivity(paneId);
      // Feed the attention tracker: a background session that streams output then
      // goes quiet lights its sidebar dot ("finished a turn / needs you").
      noteOutput(paneId);
      return;
    }
    // Control events (Exit/Error) arrive as parsed JSON objects.
    const evt = msg as PtyEvent;
    if (evt.kind === "exit") {
      usePtyStore.getState().setStatus(paneId, "exited");
      term.write(`\r\n\x1b[33m[pty exited code=${evt.code ?? "?"}]\x1b[0m\r\n`);
    } else if (evt.kind === "error") {
      usePtyStore
        .getState()
        .setStatus(paneId, "errored", formatAppError(evt.error));
      term.write(
        `\r\n\x1b[31m[pty error: ${formatAppError(evt.error)}]\x1b[0m\r\n`
      );
    }
  };

  // Best-effort sizing. The TerminalPane's ResizeObserver will refine this
  // moments later. We pass plausible defaults so the spawned shell isn't
  // born into a 1×1 grid.
  const sizing = fitTerminal(paneId) ?? { cols: 80, rows: 24 };

  try {
    await openPty({ paneId, shell, cols: sizing.cols, rows: sizing.rows, cwd, channel });
    usePtyStore.getState().setStatus(paneId, "running");
  } catch (e) {
    const msg = isAppError(e) ? formatAppError(e) : String(e);
    usePtyStore.getState().setStatus(paneId, "errored", msg);
    term.write(`\r\n\x1b[31m[pty_open failed: ${msg}]\x1b[0m\r\n`);
  }
}

async function killPane(paneId: PaneId): Promise<void> {
  // 0. A pane being torn down must not autorun a command later.
  cancelStartupAutorun(paneId);
  // 1. Tell Rust to teardown.
  try {
    await killPty(paneId);
  } catch {
    // Already dead is fine.
  }
  // 2. Pull the input wire.
  runtimes.get(paneId)?.inputDisposer.dispose();
  runtimes.delete(paneId);
  // 3. Drop the Terminal + metadata + attention/command-tracker state + any
  //    buffered background output held by the render sink.
  disposeTerminal(paneId);
  forgetRenderSink(paneId);
  usePtyStore.getState().removePane(paneId);
  forgetPane(paneId);
  forgetPaneAgent(paneId);
  // Plan 009: the USER tore this pane down (closed the pane / stopped the
  // session) — drop its resume memory. This path is never reached on app
  // shutdown (the orchestrator's disposer doesn't kill panes), which is exactly
  // the case the resume store exists to preserve.
  usePaneResumeStore.getState().clearRecord(paneId);
}

// ---------------------------------------------------------------------------
// Startup-command autorun (session restore — "your agent comes back").
//
// History: beta.1 typed the remembered command into the shell as soon as it
// spawned, which raced PSReadLine's init and could garble or freeze the
// prompt — beta.2 disabled it outright. OSC 133 gives us the missing signal:
// 133;B means "prompt rendered, input starts NOW". We arm a one-shot listener
// at revive time and type the command only when the shell itself says it's
// ready. Shells that never emit 133 (cmd, WSL) simply never fire — the
// timeout reaps the listener and the pane revives to a plain prompt.
// ---------------------------------------------------------------------------

/** Pending revive autoruns: paneId → cancel. */
const pendingAutoruns = new Map<PaneId, () => void>();

/** Generous window for slow PowerShell profiles; after this we assume the
 *  shell is not 133-integrated and give up rather than type blind. */
const AUTORUN_PROMPT_TIMEOUT_MS = 20_000;

/** Exported for tests. Production callers: reviveSpawn only. */
export function armStartupAutorun(paneId: PaneId, command: string): void {
  cancelStartupAutorun(paneId);
  const cancel = () => {
    pendingAutoruns.delete(paneId);
    off();
    window.clearTimeout(timer);
  };
  const off = onCommandEvent((evt) => {
    if (evt.paneId !== paneId || evt.type !== "prompt-ready") return;
    cancel();
    void writePty(paneId, `${command}\r`).catch(() => undefined);
    // The input-capture wire never sees writePty traffic, so an agent launched
    // by the replay must be noted here or identity + resume memory skip it
    // (Claude got rescued by its hooks; Codex/Gemini silently never resumed).
    const session = findSessionForPane(useSessionsStore.getState(), paneId);
    notePaneLaunch(paneId, command, session?.folderPath ?? null);
  });
  const timer = window.setTimeout(cancel, AUTORUN_PROMPT_TIMEOUT_MS);
  pendingAutoruns.set(paneId, cancel);
}

function cancelStartupAutorun(paneId: PaneId): void {
  pendingAutoruns.get(paneId)?.();
}

/**
 * Spawn a pane from its persisted launch memory: the shell it last ran (or the
 * default if none recorded), plus its remembered first command, re-run once
 * the shell reports prompt-ready (see autorun block above). Used both for the
 * install-time sweep and for live session activation (feature A — restore).
 *
 * Plan 009 overlay: if this pane has a live resume record (an agent was running
 * here at last exit), the raw launch command is NOT auto-run — the resume banner
 * (TerminalPane) offers [Resume] / [Just shell] instead. When the auto-resume
 * setting is ON and the agent is resumable and its cwd still exists, the resume
 * command is armed through the SAME readiness gate (armStartupAutorun).
 */
function reviveSpawn(paneId: PaneId): void {
  const spec = paneLaunchSpec(useSessionsStore.getState(), paneId);
  const record = usePaneResumeStore.getState().records[paneId];
  if (record?.aliveAtShutdown) {
    // An agent pane. The banner owns the launch on restore; never blind-replay
    // the raw `claude`/`codex` line (a fresh start would drop the conversation).
    if (usePaneResumeStore.getState().autoResumeOnRestore && isAutoResumable(record.agent)) {
      void maybeArmAutoResume(paneId, record);
    }
    void spawnPane(paneId, spec?.shell ?? defaultShell());
    return;
  }
  const command = spec?.startupCommand?.trim();
  if (command) armStartupAutorun(paneId, command);
  void spawnPane(paneId, spec?.shell ?? defaultShell());
}

/**
 * Auto-resume gate: verify the recorded cwd still exists (skip if it doesn't —
 * the banner shows a "folder missing" hint), then arm the resume command on the
 * pane through the readiness-gated autorun. The fs check is fast and the shell's
 * prompt-ready mark lands well after it, so arming here still wins the race.
 */
async function maybeArmAutoResume(paneId: PaneId, record: ResumeRecord): Promise<void> {
  // A missing cwd disqualifies auto-resume (the banner shows a "folder missing"
  // hint instead). An empty cwd is treated as present (nothing to verify).
  const cwdExists = record.cwd ? await dirExists(record.cwd) : true;
  // Re-read the record + setting AFTER the async gap — the user may have clicked
  // Just shell, or torn the pane down, while we awaited the fs check.
  const store = usePaneResumeStore.getState();
  const live = store.records[paneId];
  if (!shouldAutoResume(live, { autoResumeOn: store.autoResumeOnRestore, cwdExists })) return;
  armStartupAutorun(paneId, resumeCommandFor(live!));
}

/**
 * Install the orchestrator at app boot. Call ONCE from App.tsx. Returns an
 * unsubscriber for tests / hot reload.
 *
 * Robustness:
 *   - On install, walk every existing leaf in the layout. If a leaf has no
 *     PaneRuntime entry (channel handler), tear down anything stale and
 *     re-spawn. This makes HMR safe: the OLD orchestrator's channel
 *     handlers get GC'd when its closures are dropped, but the Rust-side
 *     PTYs and xterm instances persist. Without this re-spawn, bytes would
 *     flow from Rust to nowhere and panes would render blank.
 *   - On subscription, diff added/removed paneIds across state transitions.
 */
export function installPtyOrchestrator(): () => void {
  // Cover panes that already exist before we subscribed (HMR / cold-start
  // race where the layout was populated before this listener was attached).
  // killPane is a no-op for ids it doesn't recognise on the Rust side.
  //
  // We also dispose the existing xterm Terminal so the next spawn creates
  // a fresh one. Without this, an already-corrupted Terminal (e.g. one
  // that ended up in the open()-called-twice state during a prior buggy
  // build) would persist and the new spawn's bytes would render nowhere.
  // Scrollback is lost — acceptable cost for HMR/recovery scenarios.
  const initial = getActivePaneIds(useSessionsStore.getState());
  for (const id of initial) {
    void (async () => {
      try {
        await killPty(id);
      } catch {
        // ignore — pane may not exist on the Rust side yet
      }
      runtimes.get(id)?.inputDisposer.dispose();
      runtimes.delete(id);
      disposeTerminal(id);
      reviveSpawn(id);
    })();
  }

  const sub = useSessionsStore.subscribe((state, prev) => {
    const curr = getActivePaneIds(state);
    const before = getActivePaneIds(prev);
    const added = curr.filter((id) => !before.includes(id));
    const removed = before.filter((id) => !curr.includes(id));
    for (const id of added) reviveSpawn(id);
    for (const id of removed) void killPane(id);
  });

  // Boot-time shell auto-detection. Fire-and-forget — the right-click menu
  // reads from `detectedShells` and renders an empty submenu until this
  // resolves. Failure (e.g. detect_shells returns no shells on this host) is
  // logged but non-fatal; users can keep using the default shell.
  void detectShells()
    .then((shells) => {
      detectedShells = shells;
    })
    .catch((err) => {
      console.error("detectShells failed", err);
    });

  return () => {
    sub();
    disposeAttentionTracker();
  };
}

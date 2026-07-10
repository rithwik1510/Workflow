// coach — the ONE wiring module for the workflow coach's detectors (Plan 014
// §4/§6). initCoach() connects four episode-machines to their real event
// sources and installs the graduation seams; disposeCoach() tears it all down
// (HMR / tests). Everything the store already guards (the annoyance ceiling)
// the detectors get for free — they only ever call recordEpisode / tryPush /
// shelve / graduate.
//
// MASTER SWITCH DISCIPLINE (Plan 014 §6): every detector entry point begins with
// the same tipsEnabled() guard, so while Workflow tips are OFF nothing is
// observed, armed, timed, or recorded — not merely hidden. Turning tips off also
// cancels every pending arm/dwell timer; re-enabling starts fresh and never
// replays what happened while disabled.

import type { Terminal } from "@xterm/xterm";

import { COACH_TUNING } from "@/sessions/coachCatalog";
import { onSessionNavigation, type SessionNavigation } from "@/sessions/coachNav";
import { isCoachPaneSlotFree } from "@/components/paneOverlayArbiter";
import { claudeHooksStatus } from "@/lib/claudeHooksClient";
import { useCoachStore, coachNow, setCoachPaneSlotFree } from "@/store/coachStore";
import { useAgentStore, type PaneAgent } from "@/store/agentStore";
import { usePaneSearchStore } from "@/store/paneSearchStore";
import { usePrefsStore } from "@/store/prefsStore";
import { useSessionsStore, type SessionId } from "@/store/sessionsStore";
import { setCoachTerminalObserver, setCoachEmptyShiftCopy } from "@/terminals/registry";
import type { PaneId } from "@/types";

function tipsEnabled(): boolean {
  return usePrefsStore.getState().tipsEnabled;
}

function coach() {
  return useCoachStore.getState();
}

/** True once a tip is permanently retired — the detectors stop touching it. */
function tipRetired(tipId: "selection-rescue" | "session-thrash" | "precise-signals" | "scroll-hunt"): boolean {
  const rec = coach().tips[tipId];
  return rec?.graduatedAt !== undefined || rec?.dismissedAt !== undefined;
}

// ---------------------------------------------------------------------------
// Detector 1 — Failed TUI selection (push, rescue)
// ---------------------------------------------------------------------------

/** Pure episode-machine: a plain drag that selects nothing inside a
 *  mouse-reporting TUI, followed within 4s by Ctrl+Shift+C on the empty
 *  selection, is proof the user believes something is selected. Both → push.
 *  A successful Shift+drag selection graduates the tip. */
export function createSelectionRescueDetector() {
  const downAt = new Map<PaneId, { x: number; y: number; shift: boolean }>();
  const failedAt = new Map<PaneId, number>();

  function onPointerDown(paneId: PaneId, x: number, y: number, shift: boolean): void {
    if (!tipsEnabled()) return;
    downAt.set(paneId, { x, y, shift });
  }

  function onPointerUp(
    paneId: PaneId,
    x: number,
    y: number,
    shift: boolean,
    mouseReporting: boolean,
    hasSelection: boolean
  ): void {
    const down = downAt.get(paneId);
    downAt.delete(paneId);
    if (!tipsEnabled() || !down) return;
    const traveled = Math.hypot(x - down.x, y - down.y);

    // Graduation: a Shift+drag that produced a real selection in a mouse-
    // reporting pane — the user has learned the trick, retire the tip forever.
    if (mouseReporting && (down.shift || shift) && hasSelection) {
      coach().graduate("selection-rescue");
      return;
    }

    // Evidence (1): a plain drag (Shift absent at BOTH ends) past the travel
    // threshold that selected nothing while the TUI owned the mouse.
    if (
      traveled >= COACH_TUNING.selectionDragMinPx &&
      !down.shift &&
      !shift &&
      mouseReporting &&
      !hasSelection
    ) {
      failedAt.set(paneId, coachNow());
    }
  }

  /** Evidence (2): Ctrl+Shift+C reached the copy handler with no selection. */
  function onEmptyShiftCopy(paneId: PaneId): void {
    if (!tipsEnabled()) return;
    const at = failedAt.get(paneId);
    if (at === undefined) return;
    failedAt.delete(paneId);
    if (coachNow() - at > COACH_TUNING.selectionCopyWindowMs) return;
    coach().tryPush("selection-rescue", { kind: "pane", paneId });
  }

  function forgetPane(paneId: PaneId): void {
    downAt.delete(paneId);
    failedAt.delete(paneId);
  }
  function clear(): void {
    downAt.clear();
    failedAt.clear();
  }

  return { onPointerDown, onPointerUp, onEmptyShiftCopy, forgetPane, clear };
}

// ---------------------------------------------------------------------------
// Detector 2 — Session thrash (push then shelf)
// ---------------------------------------------------------------------------

/** ≥ thrashSwitches deliberate switches between the SAME pair within
 *  thrashWindowMs. A third session breaks the streak (resets the tracked pair).
 *  On an episode: push once (budget permitting) with the pair named in the
 *  ephemeral payload, then shelve the generic durable copy regardless. */
export function createThrashDetector() {
  let pairKey: string | null = null;
  let hits: number[] = [];

  function onNavigation(nav: SessionNavigation): void {
    if (!tipsEnabled() || tipRetired("session-thrash")) return;
    const { from, to, at } = nav;
    if (from === null) {
      pairKey = null;
      hits = [];
      return;
    }
    const key = [from, to].slice().sort().join("|");
    if (key !== pairKey) {
      pairKey = key;
      hits = [at];
    } else {
      hits.push(at);
    }
    hits = hits.filter((t) => at - t < COACH_TUNING.thrashWindowMs);
    if (hits.length >= COACH_TUNING.thrashSwitches) {
      fireEpisode(from, to);
      pairKey = null;
      hits = [];
    }
  }

  function fireEpisode(a: SessionId, b: SessionId): void {
    const sessions = useSessionsStore.getState().sessions;
    const nameA = sessions[a]?.name ?? a;
    const nameB = sessions[b]?.name ?? b;
    coach().tryPush(
      "session-thrash",
      { kind: "session-pair", sessionIds: [a, b] },
      { left: nameA, right: nameB }
    );
    // Regardless of the push outcome, preserve the advice on the shelf with the
    // GENERIC copy (never the pair names — those are ephemeral only).
    coach().shelve("session-thrash");
  }

  function clear(): void {
    pairKey = null;
    hits = [];
  }

  return { onNavigation, clear };
}

// ---------------------------------------------------------------------------
// Detector 3 — Precise-signals intro (shelf only)
// ---------------------------------------------------------------------------

function isClaudeCommand(pa: PaneAgent | undefined): boolean {
  return pa?.agent === "claude" && pa.source === "command";
}

/** Any Claude hook event proves signals already work — graduate. A hook pane
 *  entry (source "hook") or the store's canary (sawSessionStart) both count. */
function anyHookEvidence(): boolean {
  const st = useAgentStore.getState();
  if (st.sawSessionStart) return true;
  for (const id in st.panes) if (st.panes[id].source === "hook") return true;
  return false;
}

/** A claude/command pane sustained ≥ 30s with no hook events → confirm hooks are
 *  actually absent via claudeHooksStatus() ONCE, then shelve (false) or graduate
 *  (true). Any hook event graduates immediately, including during the arm. Never
 *  polls; never infers "off" from command identity alone. */
export function createPreciseSignalsDetector() {
  const armTimers = new Map<PaneId, number>();
  let hooksStatusInFlight = false;

  function cancelArm(paneId: PaneId): void {
    const t = armTimers.get(paneId);
    if (t !== undefined) {
      window.clearTimeout(t);
      armTimers.delete(paneId);
    }
  }
  function clear(): void {
    for (const t of armTimers.values()) window.clearTimeout(t);
    armTimers.clear();
  }

  /** Reconcile arms against the current agentStore. Cheap; called on every
   *  agentStore change + once at init. */
  function evaluate(): void {
    if (!tipsEnabled() || tipRetired("precise-signals")) {
      clear();
      return;
    }
    if (anyHookEvidence()) {
      coach().graduate("precise-signals");
      clear();
      return;
    }
    const panes = useAgentStore.getState().panes;
    for (const id in panes) {
      const paneId = id as PaneId;
      if (isClaudeCommand(panes[paneId]) && !armTimers.has(paneId)) {
        armTimers.set(
          paneId,
          window.setTimeout(() => armFired(paneId), COACH_TUNING.preciseSignalsArmMs)
        );
      }
    }
    for (const paneId of Array.from(armTimers.keys())) {
      if (!isClaudeCommand(panes[paneId])) cancelArm(paneId);
    }
  }

  /** The 30s arm elapsed for a pane still claude/command with no hook events. */
  function armFired(paneId: PaneId): void {
    armTimers.delete(paneId);
    if (!tipsEnabled() || tipRetired("precise-signals")) return;
    if (anyHookEvidence()) {
      coach().graduate("precise-signals");
      return;
    }
    if (!isClaudeCommand(useAgentStore.getState().panes[paneId])) return;
    if (hooksStatusInFlight) return; // one status probe per run is enough
    hooksStatusInFlight = true;
    void claudeHooksStatus()
      .then((installed) => {
        if (!tipsEnabled() || tipRetired("precise-signals")) return;
        if (installed) coach().graduate("precise-signals");
        else coach().shelve("precise-signals");
      })
      .catch(() => {
        // Couldn't read status — never shelve on a guess; allow a later retry.
        hooksStatusInFlight = false;
      });
  }

  return { evaluate, armFired, clear };
}

// ---------------------------------------------------------------------------
// Detector 4 — Scroll-hunt (shelf)
// ---------------------------------------------------------------------------

/** Viewport ≥ 300 lines above bottom with ≥ 10s dwell = one hunt; twice in a run
 *  = one episode-day; episodes on 2 distinct days → shelve. The first terminal
 *  search opened graduates it (observed independently, so an existing Ctrl+F
 *  user retro-graduates before this can ever shelve). */
export function createScrollHuntDetector() {
  const dwellTimers = new Map<PaneId, number>();
  let runHits = 0;
  let searchOpened = false;

  function clearDwell(paneId: PaneId): void {
    const t = dwellTimers.get(paneId);
    if (t !== undefined) {
      window.clearTimeout(t);
      dwellTimers.delete(paneId);
    }
  }
  function clearAllDwell(): void {
    for (const t of dwellTimers.values()) window.clearTimeout(t);
    dwellTimers.clear();
  }

  function onScroll(paneId: PaneId, linesFromBottom: number): void {
    if (!tipsEnabled() || searchOpened || tipRetired("scroll-hunt")) return;
    if (linesFromBottom >= COACH_TUNING.scrollHuntMinLinesFromBottom) {
      if (!dwellTimers.has(paneId)) {
        dwellTimers.set(
          paneId,
          window.setTimeout(() => onDwell(paneId), COACH_TUNING.scrollHuntDwellMs)
        );
      }
    } else {
      // Returned to (near) the bottom — the dwell is broken.
      clearDwell(paneId);
    }
  }

  /** A pane held ≥ 300 lines up for the full dwell. */
  function onDwell(paneId: PaneId): void {
    dwellTimers.delete(paneId);
    if (!tipsEnabled() || searchOpened || tipRetired("scroll-hunt")) return;
    runHits += 1;
    if (runHits >= COACH_TUNING.scrollHuntEpisodesPerRun) {
      runHits = 0; // this run's episode is recorded; count the next one fresh
      const days = coach().recordEpisode("scroll-hunt");
      if (days >= COACH_TUNING.scrollHuntDistinctDays) coach().shelve("scroll-hunt");
    }
  }

  /** Terminal search opened — graduate (Ctrl+F is the taught action). */
  function onSearchOpened(): void {
    if (searchOpened) return;
    searchOpened = true;
    clearAllDwell();
    coach().graduate("scroll-hunt");
  }

  function forgetPane(paneId: PaneId): void {
    clearDwell(paneId);
  }
  function clear(): void {
    clearAllDwell();
    runHits = 0;
  }
  /** Full reset (dispose) — also forgets that search was opened this run. */
  function reset(): void {
    clear();
    searchOpened = false;
  }

  return { onScroll, onDwell, onSearchOpened, forgetPane, clear, reset };
}

// ---------------------------------------------------------------------------
// Graduation seam — drag-to-split (Plan 014 §4)
// ---------------------------------------------------------------------------

/** Called from internalSessionDrag immediately after a GENUINE openSplitWith
 *  (a real pairing, not a no-op self-drop / no-active-session case). A
 *  drag-to-split proves the user knows the feature — retire session-thrash. */
export function noteDragSplitCreated(): void {
  if (!tipsEnabled()) return;
  coach().graduate("session-thrash");
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

interface CoachWiring {
  selectionRescue: ReturnType<typeof createSelectionRescueDetector>;
  thrash: ReturnType<typeof createThrashDetector>;
  preciseSignals: ReturnType<typeof createPreciseSignalsDetector>;
  scrollHunt: ReturnType<typeof createScrollHuntDetector>;
  unsubs: Array<() => void>;
  paneCleanups: Map<PaneId, () => void>;
}

let wiring: CoachWiring | null = null;

/** Clear a pane-anchored live chip when its pane dies. */
function clearPaneAnchorIfDead(paneId: PaneId): void {
  const tip = coach().activeTip;
  if (tip?.anchor.kind === "pane" && tip.anchor.paneId === paneId) coach().clearActiveTip();
}

/** Clear a session-pair live chip when either session is gone. */
function clearPairAnchorIfDead(): void {
  const tip = coach().activeTip;
  if (tip?.anchor.kind !== "session-pair") return;
  const sessions = useSessionsStore.getState().sessions;
  const [a, b] = tip.anchor.sessionIds;
  if (!sessions[a] || !sessions[b]) coach().clearActiveTip();
}

export function initCoach(): void {
  if (wiring) disposeCoach(); // idempotent (HMR / re-mount)

  const selectionRescue = createSelectionRescueDetector();
  const thrash = createThrashDetector();
  const preciseSignals = createPreciseSignalsDetector();
  const scrollHunt = createScrollHuntDetector();
  const unsubs: Array<() => void> = [];
  const paneCleanups = new Map<PaneId, () => void>();

  // Gate 6: the coach is the lowest-priority occupant of a pane's top-center
  // slot (paneOverlayArbiter ranks resume → attempt-hint → coach).
  setCoachPaneSlotFree(isCoachPaneSlotFree);

  // Detector 2: deliberate-navigation stream.
  unsubs.push(onSessionNavigation((nav) => thrash.onNavigation(nav)));
  // Retro-graduation: a durable split group proves the user already knows the
  // drag-to-split feature — never teach it.
  if (useSessionsStore.getState().splitGroups.length > 0) {
    coach().graduate("session-thrash");
  }

  // Detector 3: watch agent identities for a sustained claude/command pane.
  preciseSignals.evaluate();
  unsubs.push(useAgentStore.subscribe(() => preciseSignals.evaluate()));

  // Detector 4 graduation: the first terminal search opened (independent of any
  // pane's scroll state, so an existing Ctrl+F user retro-graduates).
  unsubs.push(
    usePaneSearchStore.subscribe((s, prev) => {
      if (s.openPaneId !== null && prev.openPaneId === null) scrollHunt.onSearchOpened();
    })
  );

  // Per-terminal listeners (Detectors 1 + 4). Attached AFTER term.open() (the
  // registry calls this once, on first open, when term.element exists), so DOM
  // reparenting never double-registers; removed in disposeTerminal.
  setCoachTerminalObserver({
    open: (paneId: PaneId, term: Terminal) => {
      const el = term.element;
      if (!el) return;
      const onDown = (e: PointerEvent) =>
        selectionRescue.onPointerDown(paneId, e.clientX, e.clientY, e.shiftKey);
      const onUp = (e: PointerEvent) => {
        const mouseReporting = term.modes.mouseTrackingMode !== "none";
        const hasSelection = term.getSelection() !== "";
        selectionRescue.onPointerUp(
          paneId,
          e.clientX,
          e.clientY,
          e.shiftKey,
          mouseReporting,
          hasSelection
        );
      };
      // Capture phase, observe-only (no preventDefault / no mutation).
      el.addEventListener("pointerdown", onDown, true);
      el.addEventListener("pointerup", onUp, true);
      const scrollDisp = term.onScroll(() => {
        const buf = term.buffer.active;
        scrollHunt.onScroll(paneId, buf.baseY - buf.viewportY);
      });
      paneCleanups.set(paneId, () => {
        el.removeEventListener("pointerdown", onDown, true);
        el.removeEventListener("pointerup", onUp, true);
        scrollDisp.dispose();
      });
    },
    dispose: (paneId: PaneId) => {
      paneCleanups.get(paneId)?.();
      paneCleanups.delete(paneId);
      selectionRescue.forgetPane(paneId);
      scrollHunt.forgetPane(paneId);
      preciseSignals.evaluate(); // the pane's agent identity may be gone now
      clearPaneAnchorIfDead(paneId); // anchor death: pane disposed
    },
  });

  // Detector 1 evidence (2): the registry's failed-copy branch.
  setCoachEmptyShiftCopy((paneId: PaneId) => selectionRescue.onEmptyShiftCopy(paneId));

  // Anchor death: either session of a pair deleted.
  unsubs.push(
    useSessionsStore.subscribe((s, prev) => {
      if (s.sessions !== prev.sessions) clearPairAnchorIfDead();
    })
  );

  // Master switch: turning tips OFF cancels every pending arm/dwell timer and
  // resets the in-run episode machines. (coachStore's own subscription clears
  // the live chip.) Re-enabling starts fresh — nothing replays.
  unsubs.push(
    usePrefsStore.subscribe((s, prev) => {
      if (prev.tipsEnabled && !s.tipsEnabled) {
        selectionRescue.clear();
        thrash.clear();
        preciseSignals.clear();
        scrollHunt.clear();
      }
    })
  );

  wiring = { selectionRescue, thrash, preciseSignals, scrollHunt, unsubs, paneCleanups };
}

export function disposeCoach(): void {
  if (!wiring) return;
  for (const un of wiring.unsubs) un();
  for (const cleanup of wiring.paneCleanups.values()) cleanup();
  wiring.paneCleanups.clear();
  wiring.selectionRescue.clear();
  wiring.thrash.clear();
  wiring.preciseSignals.clear();
  wiring.scrollHunt.reset();
  setCoachTerminalObserver(null);
  setCoachEmptyShiftCopy(null);
  wiring = null;
}

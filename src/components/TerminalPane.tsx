// TerminalPane — React component that ATTACHES a registered Terminal to a DOM
// host. It does NOT own the Terminal; the registry does. Lifecycle:
//   - mount: attach
//   - unmount: detach (Terminal stays alive in the registry)
//   - actual disposal happens when the PTY orchestrator decides
//
// React.memo'd because re-renders should be cheap (no per-byte work happens
// here — bytes flow Channel → registry.writeToTerminal directly).

import {
  memo,
  useEffect,
  useRef,
  type MouseEvent as ReactMouseEvent,
} from "react";

import { onResizeEnd, isResizing } from "@/components/resizeBus";
import { useDropTargetStore } from "@/store/dropTargetStore";
import {
  attach,
  detach,
  fitTerminal,
  focusTerminal,
  getOrCreateTerminal,
  resetMouseModes,
} from "@/terminals/registry";
import { PaneResumeBanner } from "@/components/PaneResumeBanner";
import { registerOscHandlers } from "@/sessions/oscNotifications";
import { registerClipboardOsc } from "@/sessions/oscClipboard";
import { registerCommandTracking } from "@/sessions/commandTracker";
import { muteOutput } from "@/sessions/attentionTracker";
import { readClipboardText, writeClipboardText } from "@/lib/clipboardClient";
import { resizePty } from "@/terminals/ptyClient";
import { changeShell, getDetectedShells } from "@/terminals/orchestrator";
import { useContextMenuStore, type ContextMenuItem } from "@/store/contextMenuStore";
import { useLayoutStore } from "@/store/layoutStore";
import { useMdStore } from "@/store/mdStore";
import { shellLabel } from "@/lib/shellsClient";
import type { PaneId } from "@/types";

interface Props {
  paneId: PaneId;
}

function TerminalPaneImpl({ paneId }: Props) {
  const hostRef = useRef<HTMLDivElement | null>(null);

  // Highlighted while a file is dragged over this pane. The drop itself is
  // handled outside this component — by the internal pointer-drag
  // (lib/internalFileDrag) and the external OS drop (hooks/useExternalFileDrop),
  // both of which hit-test the `data-pane-id` below. HTML5 drop handlers don't
  // work here: Tauri's dragDropEnabled suppresses them on WebView2.
  const isDropTarget = useDropTargetStore((s) => s.paneId === paneId);

  useEffect(() => {
    if (!hostRef.current) return;
    attach(paneId, hostRef.current);
    focusTerminal(paneId);

    // OSC 9/99/777 notification handlers → bump the owning session's unread
    // flag. Registered per-mount; disposed in cleanup so a split-then-close
    // pane doesn't leave dangling handlers on a reused Terminal. See §10.2.
    const unregisterOsc = registerOscHandlers(paneId, getOrCreateTerminal(paneId));

    // OSC 52 — honor clipboard writes a TUI emits (Claude Code / vim / tmux
    // copy). Writes only; read queries are denied (see oscClipboard.ts).
    const unregisterClipboardOsc = registerClipboardOsc(getOrCreateTerminal(paneId));

    // OSC 133 (FinalTerm) command-lifecycle marks — emitted by the shell
    // integration Lume injects into PowerShell-family shells. Ground truth
    // for the sidebar's working/needs-you signals (see attentionTracker.ts).
    const unregisterCmd = registerCommandTracking(paneId, getOrCreateTerminal(paneId));

    // Mouse-mode panic key (focused pane). DESIGN.md §7.
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.shiftKey && (e.key === "R" || e.key === "r")) {
        const focused = useLayoutStore.getState().focusedPaneId;
        if (focused !== paneId) return;
        e.preventDefault();
        resetMouseModes(paneId);
      }
    };
    window.addEventListener("keydown", onKeyDown, true);

    // Resize handling — see resizeBus.ts header for the root cause.
    //
    // During a splitter drag we deliberately do NOT call fit(). xterm.js's
    // WebGL renderer writes canvas.width / canvas.height inside its
    // handleResize() (verified against @xterm/addon-webgl/src/WebglRenderer.ts),
    // and writing to a WebGL canvas's pixel dimensions clears its framebuffer
    // per the WebGL spec. Doing that 60 times per second is the flicker.
    // Skipping fit() during the drag keeps the canvas dimensions stable, so
    // no clear, so no flicker. xterm content stays at its old pixel size
    // while the wrapper grows / shrinks around it — content is still visible
    // and the brief mismatch is the same pattern VSCode / JetBrains / Warp use.
    //
    // Two triggers fire fit() + PTY resize:
    //   1. ResizeObserver — handles non-drag size changes (window resize,
    //      manual layout changes). Debounced to 50 ms; if isResizing() is
    //      true the callback bails because the drag-end path will handle it.
    //   2. onResizeEnd subscription — fires exactly once at drag-end. Runs
    //      fit + resizePty immediately so content snaps into place the
    //      moment the user releases the mouse.
    let debounceTimer: number | null = null;
    let lastSentDims: { cols: number; rows: number } | null = null;
    const runFitAndResize = () => {
      // A backgrounded session's panes are display:none (MainArea) — the
      // ResizeObserver reports 0×0 for them. Fitting then would shrink the
      // PTY to a degenerate ~2-column grid, the shell would rewrap all its
      // lines vertically, and switching back would rewrap again — the
      // visible "flicker + clipped prompt" on session switch. Skip; the
      // observer fires again with real dimensions when the pane reappears.
      const el = hostRef.current;
      if (!el || el.clientWidth < 8 || el.clientHeight < 8) return;
      const dims = fitTerminal(paneId);
      if (!dims || dims.cols < 4 || dims.rows < 2) return;
      // Same grid as last time → nothing to tell the PTY (a redundant
      // resize still makes full-screen apps repaint).
      if (lastSentDims && lastSentDims.cols === dims.cols && lastSentDims.rows === dims.rows) {
        return;
      }
      lastSentDims = dims;
      // The PTY resize makes full-screen apps (agents) repaint — mute the
      // attention tracker briefly so repaint bytes don't read as activity.
      muteOutput(paneId);
      void resizePty(paneId, dims.cols, dims.rows).catch(() => undefined);
    };
    const onResize = () => {
      if (isResizing()) return; // drag-end will handle it
      if (debounceTimer !== null) window.clearTimeout(debounceTimer);
      debounceTimer = window.setTimeout(() => {
        debounceTimer = null;
        runFitAndResize();
      }, 50);
    };
    const obs = new ResizeObserver(onResize);
    obs.observe(hostRef.current);
    const unsubResizeEnd = onResizeEnd(runFitAndResize);

    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      obs.disconnect();
      unsubResizeEnd();
      if (debounceTimer !== null) window.clearTimeout(debounceTimer);
      unregisterOsc();
      unregisterClipboardOsc();
      unregisterCmd();
      detach(paneId);
    };
  }, [paneId]);

  // Click to focus this pane (UX expectation in any terminal multiplexer).
  const onMouseDown = () => {
    useLayoutStore.getState().focusPane(paneId);
    focusTerminal(paneId);
    useMdStore.getState().setFocusedSurface("terminal");
  };

  // Right-click → Copy / Paste (mirrors Ctrl+Shift+C / Ctrl+V) + a
  // "Change Shell…" submenu listing every shell detected at boot (DESIGN.md
  // §12 W3 #8-#9). Copy is omitted when nothing is selected. The submenu is
  // empty until `detectShells` resolves; harmless — just an empty submenu.
  const onContextMenu = (e: ReactMouseEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    const term = getOrCreateTerminal(paneId);
    const selection = term.getSelection();
    const shells = getDetectedShells();
    const submenu = shells.map((s) => ({
      label: shellLabel(s),
      onClick: () => void changeShell(paneId, s),
    }));
    const items: ContextMenuItem[] = [];
    if (selection) {
      items.push({ label: "Copy", onClick: () => void writeClipboardText(selection) });
    }
    items.push({
      label: "Paste",
      onClick: () =>
        void readClipboardText().then((text) => {
          if (text) term.paste(text);
        }),
    });
    items.push({ label: "", separator: true });
    items.push({ label: "Change Shell…", submenu });
    useContextMenuStore.getState().openMenu(e.clientX, e.clientY, items);
  };

  return (
    <div
      data-pane-id={paneId}
      onMouseDown={onMouseDown}
      onContextMenu={onContextMenu}
      style={{
        position: "relative",
        width: "100%",
        height: "100%",
        padding: 6,
        background: "var(--bg-0)",
        boxSizing: "border-box",
      }}
    >
      <div ref={hostRef} style={{ width: "100%", height: "100%" }} />
      {/* Resume affordance — overlays the top of the pane on restore; never
          shifts the xterm grid (Plan 009). */}
      <PaneResumeBanner paneId={paneId} />
      {isDropTarget && (
        <div
          aria-hidden="true"
          style={{
            position: "absolute",
            inset: 0,
            pointerEvents: "none",
            border: "2px solid var(--accent)",
            background: "color-mix(in srgb, var(--accent) 10%, transparent)",
            boxSizing: "border-box",
            zIndex: 3,
          }}
        />
      )}
    </div>
  );
}

export const TerminalPane = memo(TerminalPaneImpl);

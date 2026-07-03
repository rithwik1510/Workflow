// PaneTree — recursive React component that renders a LayoutNode as nested
// react-resizable-panels groups. Leaves render TerminalPane. Splits render
// a PanelGroup with two Panels and a PanelResizeHandle in between.
//
// Splitter drag flow:
//   user drags handle
//     → react-resizable-panels fires onLayout([leftPct, rightPct])
//     → we compute ratio = leftPct/100
//     → call useLayoutStore.resizeSplit(firstLeafLeft, firstLeafRight, ratio)
//     → store applies via tree.resizeSplit (clamped); next render reads new ratio
//
// We feed react-resizable-panels both `defaultSize` (initial mount) AND let
// it become uncontrolled afterwards. Updating `defaultSize` via state would
// fight the user's drag — the tree IS the source of truth, but we only push
// it back via resizeSplit when the user drags, not on every render.

import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  type MouseEvent as ReactMouseEvent,
} from "react";
import {
  Panel,
  PanelGroup,
  PanelResizeHandle,
  type ImperativePanelGroupHandle,
} from "react-resizable-panels";

import { TerminalPane } from "@/components/TerminalPane";
import { IconClose, IconExpand, IconContract } from "@/components/icons";
import { beginResize, endResize } from "@/components/resizeBus";
import zoomStyles from "@/components/PaneTree.module.css";
import { useConfirmStore } from "@/store/confirmStore";
import { useLayoutStore, getPaneIds } from "@/store/layoutStore";
import { contains, leaves, type LayoutNode } from "@/store/layout/tree";
import { isPtyBusy } from "@/terminals/ptyClient";
import { closeBusyPaneConfirm } from "@/lib/confirmStrings";

/**
 * Per-pane percentage limits during a splitter drag. Below the minimum
 * each pane gets too narrow for real shell output (wraps at <30 columns);
 * above the maximum the OTHER pane hits the same condition. 25/75 keeps
 * both panes comfortably usable across any reasonable window width —
 * tighter than the original 15/85 because squeezing a pane to 15% turns
 * out to be cramped enough that nobody actually wants to leave it there.
 */
const PANE_MIN_PCT = 25;
const PANE_MAX_PCT = 75;

interface Props {
  node: LayoutNode;
  /** Unique id within the tree — used as PanelGroup id for stable identity. */
  path: string;
}

function PaneTreeImpl({ node, path }: Props) {
  if (node.type === "leaf") {
    return <LeafFrame paneId={node.paneId} />;
  }
  return <SplitFrame node={node} path={path} />;
}

export const PaneTree = memo(PaneTreeImpl);

// ---------- Leaf rendering ----------

/** Shared chrome for the corner-cluster buttons (zoom, close) so they read as
 *  one seamless group: identical hit area, hover treatment, and transitions. */
function CornerButton({
  title,
  ariaLabel,
  onClick,
  children,
}: {
  title: string;
  ariaLabel: string;
  onClick: (e: ReactMouseEvent<HTMLButtonElement>) => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onMouseDown={(e) => e.stopPropagation()}
      onClick={onClick}
      title={title}
      aria-label={ariaLabel}
      style={{
        width: 16,
        height: 16,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        background: "transparent",
        color: "var(--fg-2)",
        border: "1px solid transparent",
        borderRadius: "var(--radius-sm)",
        cursor: "pointer",
        fontSize: 12,
        lineHeight: 1,
        padding: 0,
        transition: "color 120ms ease, background 120ms ease, border-color 120ms ease",
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.color = "var(--fg-0)";
        e.currentTarget.style.background = "var(--bg-2)";
        e.currentTarget.style.borderColor = "var(--accent-dim)";
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.color = "var(--fg-2)";
        e.currentTarget.style.background = "transparent";
        e.currentTarget.style.borderColor = "transparent";
      }}
    >
      {children}
    </button>
  );
}

interface LeafFrameProps {
  paneId: string;
}

const LeafFrameImpl = ({ paneId }: LeafFrameProps) => {
  const focused = useLayoutStore((s) => s.focusedPaneId === paneId);
  // Last-pane lock: hide the close X when there's only one leaf, because
  // closePane is a no-op for the last pane (DESIGN.md §1 invariant 1) and
  // showing a button that does nothing is worse UX than not showing one.
  const isLastPane = useLayoutStore((s) => getPaneIds(s).length <= 1);
  const closePane = useLayoutStore((s) => s.closePane);
  // Zoom: same visibility rule as the X (meaningless with one pane). While
  // zoomed this leaf is the only visible one, so ITS button is the restore.
  const isZoomed = useLayoutStore((s) => s.zoomedPaneId === paneId);
  const toggleZoomPane = useLayoutStore((s) => s.toggleZoomPane);
  const onClose = async (e: ReactMouseEvent<HTMLButtonElement>) => {
    e.preventDefault();
    e.stopPropagation();
    // CONTEXT.md invariant 3: if the PTY has running children (anything
    // beyond an idle shell), confirm before terminating. is_pty_busy
    // failures (IPC error, unknown pane) fall through to close — better
    // than soft-locking the pane behind a broken check.
    try {
      const busy = await isPtyBusy(paneId);
      if (busy) {
        const ok = await useConfirmStore.getState().confirm(closeBusyPaneConfirm(paneId));
        if (!ok) return;
      }
    } catch (err) {
      console.warn("isPtyBusy check failed", err);
    }
    closePane(paneId);
  };
  return (
    <div
      style={{
        position: "relative",
        width: "100%",
        height: "100%",
        // Uniform thin border on every pane — focus is shown by the xterm
        // cursor (visible blink), not by a heavy frame. Splitters already
        // delineate panes from each other.
        border: "1px solid var(--border)",
        background: "var(--bg-0)",
        overflow: "hidden",
        boxSizing: "border-box",
      }}
    >
      {/* Top-right corner cluster: paneId badge + close X. pointer-events
       *  selectively applied so the badge stays click-through but the X
       *  is interactive. Hidden entirely when only one pane remains. */}
      <div
        style={{
          position: "absolute",
          top: 4,
          right: 6,
          display: "flex",
          alignItems: "center",
          gap: 6,
          zIndex: 2,
          fontFamily: "var(--font-ui)",
          userSelect: "none",
        }}
      >
        <span
          style={{
            fontSize: 10,
            color: focused ? "var(--fg-1)" : "var(--fg-2)",
            pointerEvents: "none",
          }}
        >
          {paneId}
        </span>
        {!isLastPane && (
          <CornerButton
            title={isZoomed ? "Restore panes (Ctrl+Alt+Z)" : "Zoom pane (Ctrl+Alt+Z)"}
            ariaLabel={isZoomed ? `Restore panes` : `Zoom ${paneId}`}
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              toggleZoomPane(paneId);
            }}
          >
            {isZoomed ? <IconContract size={12} /> : <IconExpand size={12} />}
          </CornerButton>
        )}
        {!isLastPane && (
          <CornerButton title="Close pane (Ctrl+W)" ariaLabel={`Close ${paneId}`} onClick={onClose}>
            <IconClose size={12} />
          </CornerButton>
        )}
      </div>
      <TerminalPane paneId={paneId} />
    </div>
  );
};
const LeafFrame = memo(LeafFrameImpl);

// ---------- Split rendering ----------

const SplitFrame = memo(function SplitFrame({ node, path }: { node: LayoutNode; path: string }) {
  if (node.type !== "split") return null;

  const resizeSplit = useLayoutStore((s) => s.resizeSplit);
  const groupRef = useRef<ImperativePanelGroupHandle | null>(null);

  // Zoom (see PaneTree.module.css): when the zoomed leaf lives in this split,
  // grow its side to 100% and hide the other side + the divider. Every split
  // on the path to the leaf applies the same rule, so the leaf fills the whole
  // session area while EVERYTHING stays mounted (MainArea's xterm invariant).
  // Selector narrowed to "which side, if any" so unrelated zooms don't re-render.
  const zoomSide = useLayoutStore((s) => {
    if (s.zoomedPaneId === null || !contains(node, s.zoomedPaneId)) return null;
    return contains(node.left, s.zoomedPaneId) ? "left" : "right";
  });

  // Cache the first leaf on each side of the split. These are the two ids we
  // pass to resizeSplit so tree.ts can identify which split node to update.
  // Recomputed only when the subtree shape changes.
  const [leftAnchor, rightAnchor] = useMemo(() => {
    const l = leaves(node.left)[0];
    const r = leaves(node.right)[0];
    return [l, r] as const;
  }, [node]);

  // onLayout fires on every drag tick (~60/sec). If we update the Zustand
  // store on each tick, the whole PaneTree re-renders 60 times/sec — second-
  // order layout churn that contributes to the splitter-drag flicker.
  //
  // Strategy: debounce the store update to 120 ms after the drag settles.
  // react-resizable-panels owns the Panel sizes internally during the drag
  // (it's uncontrolled after mount). We only persist the final ratio.
  const debouncedStore = useRef<number | null>(null);
  useEffect(() => {
    return () => {
      if (debouncedStore.current !== null) window.clearTimeout(debouncedStore.current);
    };
  }, []);

  const onLayout = useCallback(
    (sizes: number[]) => {
      if (debouncedStore.current !== null) window.clearTimeout(debouncedStore.current);
      debouncedStore.current = window.setTimeout(() => {
        debouncedStore.current = null;
        const left = sizes[0];
        if (left === undefined || leftAnchor === undefined || rightAnchor === undefined) return;
        const ratio = left / 100;
        // Skip near-no-ops to avoid feedback loops on settle.
        if (Math.abs(ratio - node.ratio) < 0.001) return;
        resizeSplit(leftAnchor, rightAnchor, ratio);
      }, 120);
    },
    [leftAnchor, rightAnchor, node.ratio, resizeSplit]
  );

  const direction =
    node.orientation === "horizontal" ? "horizontal" : "vertical";

  // Default sizes pulled from the tree once. After mount, the user drives sizes.
  const leftDefault = node.ratio * 100;
  const rightDefault = 100 - leftDefault;

  return (
    <PanelGroup
      direction={direction}
      onLayout={onLayout}
      autoSaveId={undefined}
      id={`pg-${path}`}
      ref={groupRef}
      style={{ width: "100%", height: "100%" }}
    >
      <Panel
        defaultSize={leftDefault}
        minSize={PANE_MIN_PCT}
        maxSize={PANE_MAX_PCT}
        className={
          zoomSide === "left" ? zoomStyles.zoomGrow : zoomSide === "right" ? zoomStyles.zoomHide : undefined
        }
      >
        <PaneTree node={node.left} path={`${path}.L`} />
      </Panel>
      <PanelResizeHandle
        className={zoomSide !== null ? zoomStyles.zoomHide : undefined}
        onDragging={(isDragging) => {
          // Body-class toggle + per-pane fit deferral. See resizeBus.ts
          // header comment for the WebGL canvas-clear root cause.
          if (isDragging) beginResize();
          else endResize();
        }}
        style={{
          background: "var(--border)",
          ...(direction === "horizontal"
            ? { width: 3, cursor: "col-resize" }
            : { height: 3, cursor: "row-resize" }),
        }}
      />
      <Panel
        defaultSize={rightDefault}
        minSize={PANE_MIN_PCT}
        maxSize={PANE_MAX_PCT}
        className={
          zoomSide === "right" ? zoomStyles.zoomGrow : zoomSide === "left" ? zoomStyles.zoomHide : undefined
        }
      >
        <PaneTree node={node.right} path={`${path}.R`} />
      </Panel>
    </PanelGroup>
  );
});

// src/lib/internalSessionDrag.ts
//
// Pointer-based drag for "grab a session row and drop it on the main area to
// view two sessions side-by-side". We deliberately do NOT use HTML5
// drag-and-drop, for the exact reason documented in internalFileDrag.ts:
// Tauri's window `dragDropEnabled` is true (required for the OS-Explorer file
// drop), and on WebView2 the OS-level drop handler suppresses the webview's own
// dragover/drop events — so a `draggable` element silently never fires. A
// manual mousedown→mousemove→mouseup drag sidesteps the OS layer entirely.
//
// A real drag only begins once the pointer passes DRAG_THRESHOLD_PX, so a plain
// click still falls through to the row's onClick (activate the session).

import { useSessionDragStore } from "@/store/sessionDragStore";
import { useSessionsStore, type SessionId } from "@/store/sessionsStore";
import { noteDragSplitCreated } from "@/sessions/coach";

const DRAG_THRESHOLD_PX = 5;

/** Bounds of the main terminal area (the drop target), or null if not mounted. */
function mainAreaRect(): DOMRect | null {
  const el = document.querySelector("[data-main-area]") as HTMLElement | null;
  return el ? el.getBoundingClientRect() : null;
}

function isOverMainArea(x: number, y: number): boolean {
  const r = mainAreaRect();
  if (!r) return false;
  return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
}

/** A small label that follows the cursor so the drag is visible. Mirrors the
 *  file-drag ghost, prefixed with a dot to read as "a session". */
function makeGhost(label: string): HTMLDivElement {
  const g = document.createElement("div");
  g.textContent = `● ${label}`;
  g.style.cssText = [
    "position:fixed",
    "left:0",
    "top:0",
    "z-index:1000",
    "pointer-events:none",
    "padding:2px 8px",
    "border-radius:var(--radius-sm,4px)",
    "font:12px var(--font-ui,sans-serif)",
    "background:var(--bg-2,#222)",
    "color:var(--fg-0,#eee)",
    "border:1px solid var(--accent,#5fa8ff)",
    "transform:translate(10px,10px)",
  ].join(";");
  document.body.appendChild(g);
  return g;
}

/** Start a pointer-drag of a session from its sidebar row. Call from the row's
 *  onMouseDown with the session id, its display name, and the pointer's start
 *  coordinates. */
export function beginInternalSessionDrag(
  sessionId: SessionId,
  label: string,
  startX: number,
  startY: number
): void {
  let dragging = false;
  let ghost: HTMLDivElement | null = null;

  const onMove = (e: MouseEvent) => {
    if (!dragging) {
      if (Math.hypot(e.clientX - startX, e.clientY - startY) < DRAG_THRESHOLD_PX) return;
      dragging = true;
      ghost = makeGhost(label);
      useSessionDragStore.getState().setDragging(sessionId);
    }
    e.preventDefault(); // suppress text selection while dragging
    if (ghost) {
      ghost.style.left = `${e.clientX}px`;
      ghost.style.top = `${e.clientY}px`;
    }
    useSessionDragStore.getState().setOver(isOverMainArea(e.clientX, e.clientY));
  };

  const onUp = (e: MouseEvent) => {
    const wasDragging = dragging;
    const dropped = wasDragging && isOverMainArea(e.clientX, e.clientY);
    window.removeEventListener("mousemove", onMove, true);
    window.removeEventListener("mouseup", onUp, true);
    if (ghost) {
      ghost.remove();
      ghost = null;
    }
    useSessionDragStore.getState().clear();
    if (!wasDragging) return; // a plain click — let the row's onClick run

    // openSplitWith handles every case: pairs with the active session, or (when
    // there's no active session / it's a self-drop) just opens this one full.
    if (dropped) {
      // Capture the pre-drop active session: openSplitWith only creates a
      // GENUINE split when there is a different active session to pair with
      // (its no-op branch is `active === null || companionId === active`).
      const prevActive = useSessionsStore.getState().activeSessionId;
      useSessionsStore.getState().openSplitWith(sessionId);
      // Coach (Plan 014 §4): a real drag-to-split graduates the session-thrash
      // tip — the user has demonstrated the feature. Skip the no-op self-drop.
      if (prevActive !== null && prevActive !== sessionId) noteDragSplitCreated();
    }

    // Swallow the click that follows this mouseup so the row's onClick
    // (activate / collapse-the-split) doesn't also fire after a drag.
    const swallowClick = (ev: MouseEvent) => {
      ev.stopPropagation();
      ev.preventDefault();
      window.removeEventListener("click", swallowClick, true);
    };
    window.addEventListener("click", swallowClick, true);
  };

  window.addEventListener("mousemove", onMove, true);
  window.addEventListener("mouseup", onUp, true);
}

// src/components/SplitMenu.tsx
//
// Popover anchored under the TopBar's ⊞ button. Three direction items
// (→ ↑ ↓) — clicking one splits the focused pane in that direction and
// dismisses the popup. Click-outside or Escape also closes it.
//
// Position is read from splitMenuStore.anchorX/anchorY (TopBar pushes
// the ⊞ button's bottom-left into the store via show()).

import { useEffect, useRef } from "react";

import styles from "@/components/SplitMenu.module.css";
import { IconArrowRight, IconArrowUp, IconArrowDown } from "@/components/icons";
import { nextPaneId } from "@/lib/paneIds";
import { useLayoutStore } from "@/store/layoutStore";
import { useSplitMenuStore } from "@/store/splitMenuStore";
import { usePresence } from "@/hooks/usePresence";

export function SplitMenu() {
  const open = useSplitMenuStore((s) => s.open);
  const x = useSplitMenuStore((s) => s.anchorX);
  const y = useSplitMenuStore((s) => s.anchorY);
  const close = useSplitMenuStore((s) => s.close);
  const ref = useRef<HTMLDivElement | null>(null);
  const { mounted, state } = usePresence(open, 120);

  // Click-outside closes; Esc closes. Capture-phase keydown so Esc wins
  // over xterm when a Terminal Pane has DOM focus underneath.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      // Skip if click landed on the SplitMenu trigger button — the button's
      // onClick handles toggling itself. Without this skip, mousedown would
      // close the menu and then the trigger's onClick would reopen it.
      const target = e.target as HTMLElement | null;
      if (target?.closest?.("[data-split-menu-trigger]")) return;
      if (ref.current && !ref.current.contains(target as Node)) close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        close();
      }
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [open, close]);

  if (!mounted) return null;

  const doSplit = (dir: "right" | "down" | "up") => {
    const focused = useLayoutStore.getState().focusedPaneId;
    if (focused === null) {
      close();
      return;
    }
    useLayoutStore.getState().splitPane(dir, nextPaneId(), focused);
    close();
  };

  return (
    <div
      ref={ref}
      className={styles.menu}
      data-state={state}
      style={{ left: x, top: y }}
      role="menu"
      aria-label="Split focused pane"
    >
      <button
        className={styles.item}
        onClick={() => doSplit("right")}
        title="Split right (Ctrl+Alt+→)"
        aria-label="Split right"
        role="menuitem"
      >
        <IconArrowRight size={24} strokeWidth={2.5} />
      </button>
      <button
        className={styles.item}
        onClick={() => doSplit("up")}
        title="Split up (Ctrl+Alt+↑)"
        aria-label="Split up"
        role="menuitem"
      >
        <IconArrowUp size={24} strokeWidth={2.5} />
      </button>
      <button
        className={styles.item}
        onClick={() => doSplit("down")}
        title="Split down (Ctrl+Alt+↓)"
        aria-label="Split down"
        role="menuitem"
      >
        <IconArrowDown size={24} strokeWidth={2.5} />
      </button>
    </div>
  );
}

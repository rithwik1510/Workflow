// src/components/ShortcutsModal.tsx
//
// Read-only modal listing every keyboard shortcut from DESIGN.md §7,
// grouped by category. The CATALOG below is a static array — when
// DESIGN.md §7 changes, update here. There's no shared source of truth
// in v0.1; v0.2 polish could derive this from a config layer.
//
// Static catalog of v0.1 shortcuts that are actually wired in
// useKeyboardShortcuts.ts. DESIGN.md §7 lists additional shortcuts
// (Find, font sizing, terminal-specific copy/paste) that are not yet
// implemented — those are v0.2 candidates; surfacing them here would
// mislead users since they currently do nothing.
//
// Esc dismisses (capture-phase keydown so it wins over xterm when a
// Terminal Pane has DOM focus underneath). Backdrop click also closes;
// clicks inside the modal body do not (event.stopPropagation on the
// inner container).

import { useEffect } from "react";

import styles from "@/components/ShortcutsModal.module.css";
import { IconClose } from "@/components/icons";
import { SignalIndicator, AgentGlyph } from "@/components/SignalIndicator";
import type { SidebarSignal } from "@/sessions/sessionSignal";
import { useShortcutsModalStore } from "@/store/shortcutsModalStore";
import { usePresence } from "@/hooks/usePresence";

interface ShortcutRow {
  label: string;
  keys: string[];
}
interface ShortcutGroup {
  name: string;
  rows: ShortcutRow[];
}

const CATALOG: ShortcutGroup[] = [
  {
    name: "Panes",
    rows: [
      { label: "Split right", keys: ["Ctrl", "Alt", "→"] },
      { label: "Split up", keys: ["Ctrl", "Alt", "↑"] },
      { label: "Split down", keys: ["Ctrl", "Alt", "↓"] },
      { label: "Focus right / left / up / down", keys: ["Ctrl", "→ ← ↑ ↓"] },
      { label: "Close focused pane", keys: ["Ctrl", "W"] },
      { label: "Reset terminal mouse modes (focused)", keys: ["Ctrl", "Shift", "R"] },
    ],
  },
  {
    name: "Surfaces",
    rows: [
      { label: "Toggle Sidebar", keys: ["Ctrl", "B"] },
      { label: "Toggle Editor Full View", keys: ["Ctrl", "E"] },
      { label: "Toggle MD Quick Viewer", keys: ["Ctrl", "Shift", "M"] },
      { label: "Open file", keys: ["Ctrl", "O"] },
      { label: "Open Folder (workspace)", keys: ["Ctrl", "K", "Ctrl", "O"] },
      { label: "Show keyboard shortcuts", keys: ["Ctrl", "?"] },
    ],
  },
  {
    name: "Editor",
    rows: [
      { label: "Save", keys: ["Ctrl", "S"] },
      { label: "Close active tab", keys: ["Ctrl", "W"] },
      { label: "Cycle Editor tabs", keys: ["Ctrl", "Tab"] },
      { label: "Cycle Editor tabs backward", keys: ["Ctrl", "Shift", "Tab"] },
    ],
  },
];

// The durable answer to "what does this dot mean?" without leaving the app
// (Plan 008 legibility). Only shown for background sessions — the session you
// are viewing never signals.
const LEGEND: { signal: SidebarSignal; name: string; meaning: string }[] = [
  { signal: "permission", name: "Waiting on permission", meaning: "Agent blocked mid-turn — approve to continue" },
  { signal: "your-move", name: "Your move", meaning: "Turn complete / waiting at the prompt" },
  { signal: "working", name: "Working", meaning: "A turn is in progress" },
  { signal: "idle", name: "Idle", meaning: "Open, nothing running" },
];

export function ShortcutsModal() {
  const open = useShortcutsModalStore((s) => s.open);
  const close = useShortcutsModalStore((s) => s.closeModal);
  const { mounted, state } = usePresence(open, 160);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        close();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, close]);

  if (!mounted) return null;

  return (
    <div
      className={styles.backdrop}
      data-state={state}
      onClick={close}
      role="dialog"
      aria-modal="true"
      aria-labelledby="shortcuts-modal-title"
    >
      <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
        <div className={styles.header} id="shortcuts-modal-title">
          Keyboard shortcuts
          <button
            className={styles.closeBtn}
            onClick={close}
            aria-label="Close shortcuts modal"
            title="Close (Esc)"
          >
            <IconClose size={12} />
          </button>
        </div>
        <div className={styles.body}>
          {CATALOG.map((group) => (
            <div key={group.name} className={styles.group}>
              <div className={styles.groupHeader}>{group.name}</div>
              {group.rows.map((row) => (
                <div key={row.label} className={styles.row}>
                  <span className={styles.label}>{row.label}</span>
                  <span className={styles.keys}>
                    {row.keys.map((k, i) => (
                      <kbd key={`${row.label}-${i}`} className={styles.key}>
                        {k}
                      </kbd>
                    ))}
                  </span>
                </div>
              ))}
            </div>
          ))}
          <div className={styles.group}>
            <div className={styles.groupHeader}>Signals</div>
            {LEGEND.map((item) => (
              <div key={item.signal} className={styles.row}>
                <span className={styles.signalLabel}>
                  <SignalIndicator signal={item.signal} />
                  {item.name}
                </span>
                <span className={styles.signalMeaning}>{item.meaning}</span>
              </div>
            ))}
            <div className={styles.row}>
              <span className={styles.signalLabel}>Agent glyph</span>
              <span className={styles.signalMeaning}>
                Identifies the agent: ✻ Claude ·{" "}
                <span className={styles.legendGlyph} aria-hidden="true">
                  <AgentGlyph agent="codex" />
                </span>{" "}
                Codex · ✦ Gemini
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

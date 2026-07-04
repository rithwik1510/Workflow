// PaneSearchBar — the slim Ctrl+F scrollback-search overlay for a terminal pane
// (Plan 012). Pinned top-right BELOW the corner cluster (pane badge / zoom /
// close); an absolute overlay so it never reflows the xterm grid.
//
// The heavy lifting lives in the SearchAddon (registry.ts): this component is a
// thin view over paneSearchStore + the addon's find helpers.
//   - typing searches incrementally (debounced ~120 ms, case-insensitive)
//   - Enter = next, Shift+Enter = prev
//   - Esc closes AND returns DOM focus to the terminal
// The live "3/17" counter is fed by the addon's onDidChangeResults.
//
// Same overlay grammar as PaneResumeBanner: usePresence in/out, var() literal
// fallbacks on every custom property, reduced-motion handled by the app-wide
// rule (usePresence short-circuits mount/unmount).

import { useEffect, useRef } from "react";

import styles from "@/components/PaneSearchBar.module.css";
import { IconChevron, IconClose, IconSearch } from "@/components/icons";
import { usePresence } from "@/hooks/usePresence";
import { usePaneSearchStore } from "@/store/paneSearchStore";
import {
  clearTerminalSearch,
  focusTerminal,
  onTerminalSearchResults,
  terminalFindNext,
  terminalFindPrevious,
} from "@/terminals/registry";
import type { PaneId } from "@/types";

const DEBOUNCE_MS = 120;

export function PaneSearchBar({ paneId }: { paneId: PaneId }) {
  const isOpen = usePaneSearchStore((s) => s.openPaneId === paneId);
  const query = usePaneSearchStore((s) => s.query);
  const matchIndex = usePaneSearchStore((s) => s.matchIndex);
  const matchCount = usePaneSearchStore((s) => s.matchCount);
  const setQuery = usePaneSearchStore((s) => s.setQuery);
  const setResults = usePaneSearchStore((s) => s.setResults);
  const close = usePaneSearchStore((s) => s.close);

  const { mounted, state } = usePresence(isOpen, DEBOUNCE_MS);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Subscribe to the addon's match-count changes while open; clear the
  // highlights when the bar closes (or the pane unmounts).
  useEffect(() => {
    if (!isOpen) return;
    const sub = onTerminalSearchResults(paneId, ({ resultIndex, resultCount }) =>
      setResults(resultIndex, resultCount)
    );
    return () => {
      sub?.dispose();
      clearTerminalSearch(paneId);
    };
  }, [isOpen, paneId, setResults]);

  // Focus the input the moment the bar opens so you can just start typing.
  useEffect(() => {
    if (isOpen) inputRef.current?.focus();
  }, [isOpen]);

  // Incremental search — debounced so a fast typist doesn't re-scan per key.
  useEffect(() => {
    if (!isOpen) return;
    const id = window.setTimeout(() => {
      if (query) terminalFindNext(paneId, query, { incremental: true });
      else {
        clearTerminalSearch(paneId);
        setResults(-1, 0);
      }
    }, DEBOUNCE_MS);
    return () => window.clearTimeout(id);
  }, [query, isOpen, paneId, setResults]);

  if (!mounted) return null;

  const onClose = () => {
    close();
    focusTerminal(paneId);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      if (!query) return;
      if (e.shiftKey) terminalFindPrevious(paneId, query);
      else terminalFindNext(paneId, query);
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      onClose();
    }
  };

  const counter = query ? (matchCount > 0 ? `${matchIndex}/${matchCount}` : "0/0") : "";

  return (
    <div className={styles.bar} data-state={state} role="search">
      <span className={styles.leading} aria-hidden="true">
        <IconSearch size={12} />
      </span>
      <input
        ref={inputRef}
        className={styles.input}
        type="text"
        value={query}
        placeholder="Find"
        aria-label="Find in terminal"
        spellCheck={false}
        autoComplete="off"
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={onKeyDown}
      />
      <span
        className={`${styles.counter} ${query && matchCount === 0 ? styles.counterEmpty : ""}`}
        aria-live="polite"
      >
        {counter}
      </span>
      <button
        type="button"
        className={styles.btn}
        title="Previous match (Shift+Enter)"
        aria-label="Previous match"
        disabled={matchCount === 0}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => query && terminalFindPrevious(paneId, query)}
      >
        <span className={styles.chevronUp}>
          <IconChevron size={12} />
        </span>
      </button>
      <button
        type="button"
        className={styles.btn}
        title="Next match (Enter)"
        aria-label="Next match"
        disabled={matchCount === 0}
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => query && terminalFindNext(paneId, query)}
      >
        <IconChevron size={12} />
      </button>
      <button
        type="button"
        className={styles.btn}
        title="Close (Esc)"
        aria-label="Close search"
        onMouseDown={(e) => e.preventDefault()}
        onClick={onClose}
      >
        <IconClose size={12} />
      </button>
    </div>
  );
}

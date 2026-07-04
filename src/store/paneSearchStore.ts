// src/store/paneSearchStore.ts
//
// Micro-store for the Ctrl+F scrollback search overlay (Plan 012). Follows the
// splitMenu/contextMenu precedent: dumb UI state only, no cross-store reads.
//
// Exactly ONE pane's search bar is open at a time (openPaneId). The query and
// the live match counter (fed by the SearchAddon's onDidChangeResults) live
// here so the overlay component stays a thin view. Match index is 1-based for
// display ("3/17"); 0/0 means "no matches" (or empty query).

import { create } from "zustand";

import type { PaneId } from "@/types";

interface PaneSearchState {
  /** The pane whose search bar is open, or null when no bar is showing. */
  openPaneId: PaneId | null;
  /** Current query text. */
  query: string;
  /** 1-based index of the active match (0 when there are none). */
  matchIndex: number;
  /** Total match count (0 when there are none). */
  matchCount: number;
}

interface PaneSearchActions {
  /** Open the search bar for `paneId`, resetting query + counter. */
  open: (paneId: PaneId) => void;
  /** Close the bar (whichever pane owns it) and clear the counter. */
  close: () => void;
  setQuery: (query: string) => void;
  /** Fed from the addon's onDidChangeResults. resultIndex is 0-based / -1. */
  setResults: (resultIndex: number, resultCount: number) => void;
}

export type PaneSearchStore = PaneSearchState & PaneSearchActions;

export const usePaneSearchStore = create<PaneSearchStore>((set) => ({
  openPaneId: null,
  query: "",
  matchIndex: 0,
  matchCount: 0,

  open: (paneId) => set({ openPaneId: paneId, query: "", matchIndex: 0, matchCount: 0 }),
  close: () => set({ openPaneId: null, matchIndex: 0, matchCount: 0 }),
  setQuery: (query) => set({ query }),
  setResults: (resultIndex, resultCount) =>
    set({
      // onDidChangeResults reports resultIndex -1 (no active match) and a 0-based
      // index otherwise. Present it 1-based, clamped to 0 when empty.
      matchIndex: resultCount > 0 && resultIndex >= 0 ? resultIndex + 1 : 0,
      matchCount: resultCount,
    }),
}));

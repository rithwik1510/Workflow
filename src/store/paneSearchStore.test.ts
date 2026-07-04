import { describe, it, expect, beforeEach } from "vitest";

import { usePaneSearchStore } from "@/store/paneSearchStore";

beforeEach(() => {
  usePaneSearchStore.setState({ openPaneId: null, query: "", matchIndex: 0, matchCount: 0 });
});

describe("paneSearchStore", () => {
  it("open targets a pane and resets query + counter", () => {
    usePaneSearchStore.setState({ query: "stale", matchIndex: 3, matchCount: 9 });
    usePaneSearchStore.getState().open("pane-2");
    const s = usePaneSearchStore.getState();
    expect(s.openPaneId).toBe("pane-2");
    expect(s.query).toBe("");
    expect(s.matchIndex).toBe(0);
    expect(s.matchCount).toBe(0);
  });

  it("close clears the open pane and the counter", () => {
    usePaneSearchStore.getState().open("pane-1");
    usePaneSearchStore.getState().setResults(2, 5);
    usePaneSearchStore.getState().close();
    const s = usePaneSearchStore.getState();
    expect(s.openPaneId).toBeNull();
    expect(s.matchCount).toBe(0);
    expect(s.matchIndex).toBe(0);
  });

  it("setResults presents a 0-based active index as 1-based", () => {
    usePaneSearchStore.getState().setResults(0, 17);
    expect(usePaneSearchStore.getState().matchIndex).toBe(1);
    expect(usePaneSearchStore.getState().matchCount).toBe(17);
    usePaneSearchStore.getState().setResults(2, 17);
    expect(usePaneSearchStore.getState().matchIndex).toBe(3);
  });

  it("setResults clamps to 0/0 when there is no active match", () => {
    usePaneSearchStore.getState().setResults(-1, 0);
    expect(usePaneSearchStore.getState().matchIndex).toBe(0);
    expect(usePaneSearchStore.getState().matchCount).toBe(0);
  });
});

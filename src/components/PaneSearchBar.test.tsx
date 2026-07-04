import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";

// Registry owns the real xterm Terminals; mock its search surface so the bar can
// be exercised headlessly. `results` captures the onDidChangeResults handler so
// the test can push match counts as the addon would.
const { findNext, findPrevious, clearSearch, focusTerminal, results } = vi.hoisted(() => ({
  findNext: vi.fn(() => true),
  findPrevious: vi.fn(() => true),
  clearSearch: vi.fn(),
  focusTerminal: vi.fn(),
  results: { handler: null as null | ((r: { resultIndex: number; resultCount: number }) => void) },
}));
vi.mock("@/terminals/registry", () => ({
  terminalFindNext: (...a: unknown[]) => findNext(...(a as [])),
  terminalFindPrevious: (...a: unknown[]) => findPrevious(...(a as [])),
  clearTerminalSearch: (...a: unknown[]) => clearSearch(...(a as [])),
  focusTerminal: (...a: unknown[]) => focusTerminal(...(a as [])),
  onTerminalSearchResults: (_paneId: string, h: (r: { resultIndex: number; resultCount: number }) => void) => {
    results.handler = h;
    return { dispose: vi.fn(() => (results.handler = null)) };
  },
}));

import { PaneSearchBar } from "@/components/PaneSearchBar";
import { usePaneSearchStore } from "@/store/paneSearchStore";

beforeEach(() => {
  vi.useFakeTimers();
  findNext.mockClear();
  findPrevious.mockClear();
  clearSearch.mockClear();
  focusTerminal.mockClear();
  results.handler = null;
  usePaneSearchStore.setState({ openPaneId: null, query: "", matchIndex: 0, matchCount: 0 });
});
afterEach(() => {
  vi.useRealTimers();
});

describe("PaneSearchBar — overlay states", () => {
  it("renders nothing when closed", () => {
    const { container } = render(<PaneSearchBar paneId="pane-1" />);
    expect(container.firstChild).toBeNull();
  });

  it("renders nothing when open for a DIFFERENT pane", () => {
    act(() => usePaneSearchStore.getState().open("pane-2"));
    const { container } = render(<PaneSearchBar paneId="pane-1" />);
    expect(container.firstChild).toBeNull();
  });

  it("shows the input when open for this pane", () => {
    act(() => usePaneSearchStore.getState().open("pane-1"));
    render(<PaneSearchBar paneId="pane-1" />);
    expect(screen.getByLabelText("Find in terminal")).toBeTruthy();
  });
});

describe("PaneSearchBar — search behavior", () => {
  it("typing runs a debounced incremental findNext", () => {
    act(() => usePaneSearchStore.getState().open("pane-1"));
    render(<PaneSearchBar paneId="pane-1" />);
    const input = screen.getByLabelText("Find in terminal");
    act(() => {
      fireEvent.change(input, { target: { value: "error" } });
    });
    expect(findNext).not.toHaveBeenCalled(); // still within debounce
    act(() => vi.advanceTimersByTime(120));
    expect(findNext).toHaveBeenCalledWith("pane-1", "error", { incremental: true });
  });

  it("shows the live match counter from onDidChangeResults", () => {
    act(() => usePaneSearchStore.getState().open("pane-1"));
    act(() => usePaneSearchStore.getState().setQuery("x"));
    render(<PaneSearchBar paneId="pane-1" />);
    act(() => results.handler?.({ resultIndex: 2, resultCount: 17 }));
    expect(screen.getByText("3/17")).toBeTruthy();
  });

  it("Enter = next, Shift+Enter = prev", () => {
    act(() => usePaneSearchStore.getState().open("pane-1"));
    act(() => usePaneSearchStore.getState().setQuery("x"));
    render(<PaneSearchBar paneId="pane-1" />);
    const input = screen.getByLabelText("Find in terminal");
    act(() => fireEvent.keyDown(input, { key: "Enter" }));
    expect(findNext).toHaveBeenCalledWith("pane-1", "x");
    act(() => fireEvent.keyDown(input, { key: "Enter", shiftKey: true }));
    expect(findPrevious).toHaveBeenCalledWith("pane-1", "x");
  });

  it("Esc closes the bar and returns focus to the terminal", () => {
    act(() => usePaneSearchStore.getState().open("pane-1"));
    render(<PaneSearchBar paneId="pane-1" />);
    const input = screen.getByLabelText("Find in terminal");
    act(() => fireEvent.keyDown(input, { key: "Escape" }));
    expect(usePaneSearchStore.getState().openPaneId).toBeNull();
    expect(focusTerminal).toHaveBeenCalledWith("pane-1");
  });

  it("clears highlights when the bar closes", () => {
    act(() => usePaneSearchStore.getState().open("pane-1"));
    const { rerender } = render(<PaneSearchBar paneId="pane-1" />);
    clearSearch.mockClear();
    act(() => usePaneSearchStore.getState().close());
    rerender(<PaneSearchBar paneId="pane-1" />);
    expect(clearSearch).toHaveBeenCalledWith("pane-1");
  });
});

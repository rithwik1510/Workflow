import { describe, it, expect, beforeEach, vi } from "vitest";

// useKeyboardShortcuts pulls in tauri-backed sibling modules at import time.
// Stub them so importing the routing helper never touches a real plugin — no
// user config / dialog / pty is ever hit.
vi.mock("@tauri-apps/plugin-store", () => ({
  load: vi.fn(async () => ({
    get: vi.fn(async () => null),
    set: vi.fn(async () => undefined),
    delete: vi.fn(async () => undefined),
  })),
}));
vi.mock("@/lib/dialogClient", () => ({
  pickFolder: vi.fn(async () => null),
  pickEditorFile: vi.fn(async () => null),
}));
vi.mock("@/terminals/ptyClient", () => ({ isPtyBusy: vi.fn(async () => false) }));
vi.mock("@/lib/sessions/sessionEntryFlows", () => ({ pickAndCreateSession: vi.fn() }));

import { openTerminalSearch } from "@/hooks/useKeyboardShortcuts";
import { useMdStore } from "@/store/mdStore";
import { useLayoutStore } from "@/store/layoutStore";
import { usePaneSearchStore } from "@/store/paneSearchStore";

beforeEach(() => {
  usePaneSearchStore.setState({ openPaneId: null, query: "", matchIndex: 0, matchCount: 0 });
  useMdStore.getState().setFocusedSurface(null);
  useLayoutStore.setState({ focusedPaneId: null });
});

describe("openTerminalSearch — Ctrl+F routing matrix", () => {
  it("opens search when a terminal is focused", () => {
    useMdStore.getState().setFocusedSurface("terminal");
    useLayoutStore.setState({ focusedPaneId: "pane-3" });
    expect(openTerminalSearch()).toBe(true);
    expect(usePaneSearchStore.getState().openPaneId).toBe("pane-3");
  });

  it("does NOT open when the MD editor is focused (CodeMirror keeps its find)", () => {
    useMdStore.getState().setFocusedSurface("md-editor");
    useLayoutStore.setState({ focusedPaneId: "pane-3" });
    expect(openTerminalSearch()).toBe(false);
    expect(usePaneSearchStore.getState().openPaneId).toBeNull();
  });

  it("does NOT open for other surfaces (quick-viewer, sidebar, null)", () => {
    for (const surface of ["quick-viewer", "sidebar", null] as const) {
      useMdStore.getState().setFocusedSurface(surface);
      useLayoutStore.setState({ focusedPaneId: "pane-3" });
      expect(openTerminalSearch()).toBe(false);
      expect(usePaneSearchStore.getState().openPaneId).toBeNull();
    }
  });

  it("does NOT open when terminal focused but no pane id is set", () => {
    useMdStore.getState().setFocusedSurface("terminal");
    useLayoutStore.setState({ focusedPaneId: null });
    expect(openTerminalSearch()).toBe(false);
    expect(usePaneSearchStore.getState().openPaneId).toBeNull();
  });
});

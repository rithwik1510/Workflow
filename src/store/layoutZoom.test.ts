// Pane zoom semantics (layoutStore.zoomedPaneId). The invariant under test:
// zoom exists ONLY while the zoomed pane is in the active session's tree AND
// owns focus — any focus move, split, close, or session switch restores the
// grid (tmux `prefix z` muscle memory). Enforced by toggleZoomPane + the
// sessionsStore→layoutStore mirror, so we drive both stores here.

import { describe, it, expect, beforeEach, vi } from "vitest";

// persist middleware needs the plugin mocked (mirrors sessionsStore.test.ts).
vi.mock("@tauri-apps/plugin-store", () => ({
  load: vi.fn(async () => ({
    get: vi.fn(async () => null),
    set: vi.fn(async () => undefined),
    delete: vi.fn(async () => undefined),
    save: vi.fn(async () => undefined),
  })),
}));

import { useLayoutStore } from "@/store/layoutStore";
import { useSessionsStore } from "@/store/sessionsStore";
import { leaf, split } from "@/store/layout/tree";

/** Active session with two panes (a|b), pane-a focused. Returns its id. */
function twoPaneSession(): string {
  const s = useSessionsStore.getState();
  const id = s.createSession("/proj", "Work");
  s.setLayoutRoot(id, split("horizontal", 0.5, leaf("pane-a"), leaf("pane-b")));
  s.activateSession(id);
  s.setFocusedPane(id, "pane-a");
  return id;
}

beforeEach(() => {
  useLayoutStore.getState().reset(); // clears zoom + resets sessionsStore
});

describe("layoutStore — pane zoom", () => {
  it("toggles zoom on the focused pane and back", () => {
    twoPaneSession();
    useLayoutStore.getState().toggleZoomPane();
    expect(useLayoutStore.getState().zoomedPaneId).toBe("pane-a");
    useLayoutStore.getState().toggleZoomPane();
    expect(useLayoutStore.getState().zoomedPaneId).toBeNull();
  });

  it("zooming an unfocused pane (corner button) also hands it focus", () => {
    twoPaneSession();
    useLayoutStore.getState().toggleZoomPane("pane-b");
    const s = useLayoutStore.getState();
    expect(s.zoomedPaneId).toBe("pane-b");
    expect(s.focusedPaneId).toBe("pane-b"); // keyboard follows the zoom
  });

  it("no-ops on a single-pane layout (nothing to zoom over)", () => {
    const s = useSessionsStore.getState();
    const id = s.createSession("/proj", "Solo");
    s.setLayoutRoot(id, leaf("pane-a"));
    s.activateSession(id);
    s.setFocusedPane(id, "pane-a");
    useLayoutStore.getState().toggleZoomPane();
    expect(useLayoutStore.getState().zoomedPaneId).toBeNull();
  });

  it("no-ops for a pane outside the active tree", () => {
    twoPaneSession();
    useLayoutStore.getState().toggleZoomPane("pane-elsewhere");
    expect(useLayoutStore.getState().zoomedPaneId).toBeNull();
  });

  it("restores when focus moves to another pane", () => {
    const id = twoPaneSession();
    useLayoutStore.getState().toggleZoomPane();
    expect(useLayoutStore.getState().zoomedPaneId).toBe("pane-a");
    useSessionsStore.getState().setFocusedPane(id, "pane-b");
    expect(useLayoutStore.getState().zoomedPaneId).toBeNull();
  });

  it("restores when the zoomed pane is closed", () => {
    twoPaneSession();
    useLayoutStore.getState().toggleZoomPane();
    useLayoutStore.getState().closePane("pane-a");
    expect(useLayoutStore.getState().zoomedPaneId).toBeNull();
  });

  it("restores when a split adds a new pane (which takes focus)", () => {
    twoPaneSession();
    useLayoutStore.getState().toggleZoomPane();
    useLayoutStore.getState().splitPane("right", "pane-c");
    const s = useLayoutStore.getState();
    expect(s.zoomedPaneId).toBeNull();
    expect(s.focusedPaneId).toBe("pane-c");
  });

  it("restores on session switch", () => {
    twoPaneSession();
    useLayoutStore.getState().toggleZoomPane();
    const s = useSessionsStore.getState();
    const other = s.createSession("/other", "Front");
    s.setLayoutRoot(other, leaf("pane-x"));
    s.activateSession(other);
    expect(useLayoutStore.getState().zoomedPaneId).toBeNull();
  });
});

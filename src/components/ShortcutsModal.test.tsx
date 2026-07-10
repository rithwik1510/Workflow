import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

vi.mock("@tauri-apps/plugin-store", () => ({
  load: vi.fn(async () => ({
    get: vi.fn(async () => null),
    set: vi.fn(async () => undefined),
    delete: vi.fn(async () => undefined),
  })),
}));

import { ShortcutsModal } from "@/components/ShortcutsModal";
import { useShortcutsModalStore } from "@/store/shortcutsModalStore";
import { useCoachStore } from "@/store/coachStore";

beforeEach(() => {
  useShortcutsModalStore.setState({ open: false });
  useCoachStore.getState().reset();
});

describe("ShortcutsModal — Shortcuts & tips", () => {
  it("is titled 'Shortcuts & tips'", () => {
    useShortcutsModalStore.getState().openModal();
    render(<ShortcutsModal />);
    expect(screen.getByText(/Shortcuts & tips/i)).toBeTruthy();
  });

  it("hides the 'For you' group when nothing is shelved", () => {
    useShortcutsModalStore.getState().openModal();
    render(<ShortcutsModal />);
    expect(screen.queryByText("For you")).toBeNull();
  });

  it("shows a shelved tip in 'For you' with the GENERIC thrash copy", () => {
    useCoachStore.getState().shelve("session-thrash");
    useShortcutsModalStore.getState().openModal();
    render(<ShortcutsModal />);
    expect(screen.getByText("For you")).toBeTruthy();
    // Generic durable copy — never the observed pair names.
    expect(screen.getByText(/Drag one session onto another/i)).toBeTruthy();
  });

  it("hides a graduated tip and a dismissed tip from 'For you'", () => {
    useCoachStore.getState().shelve("scroll-hunt");
    useCoachStore.getState().graduate("scroll-hunt");
    useCoachStore.getState().shelve("precise-signals");
    useCoachStore.getState().dismissForever("precise-signals");
    useShortcutsModalStore.getState().openModal();
    render(<ShortcutsModal />);
    expect(screen.queryByText("For you")).toBeNull();
  });

  it("opening the modal clears the ⌨ shelf dot (markShelfOpened)", () => {
    useCoachStore.getState().shelve("scroll-hunt");
    expect(useCoachStore.getState().shelfHasNew).toBe(true);
    useShortcutsModalStore.getState().openModal();
    render(<ShortcutsModal />);
    expect(useCoachStore.getState().shelfHasNew).toBe(false);
  });

  it("a per-row 'Don't suggest this' dismisses the shelved tip", () => {
    useCoachStore.getState().shelve("scroll-hunt");
    useShortcutsModalStore.getState().openModal();
    render(<ShortcutsModal />);
    fireEvent.click(screen.getByRole("button", { name: /Don.t suggest this/i }));
    expect(useCoachStore.getState().tips["scroll-hunt"].dismissedAt).toBeDefined();
  });
});

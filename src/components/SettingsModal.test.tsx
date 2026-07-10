import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

// Stub shell detection so the open-effect doesn't hit Tauri invoke; keep the
// label/id helpers real.
vi.mock("@/lib/shellsClient", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/shellsClient")>();
  return { ...actual, detectShells: vi.fn(async () => []) };
});

import { SettingsModal } from "@/components/SettingsModal";
import { useSettingsModalStore } from "@/store/settingsModalStore";
import { useSettingsStore } from "@/store/settingsStore";
import { usePrefsStore } from "@/store/prefsStore";
import { useCoachStore } from "@/store/coachStore";

// Guards against a control being wired to the wrong dotted path — a typo no
// other test catches (the optimistic write + disk persist would silently
// target the wrong key).
describe("SettingsModal — control wiring", () => {
  beforeEach(() => {
    useSettingsStore.getState().reset();
    useSettingsModalStore.setState({ open: true, category: "appearance" });
  });

  it("wires the cursor-shape segments to terminal.cursor_style", () => {
    const set = vi.fn();
    useSettingsStore.setState({ setConfigValue: set });
    render(<SettingsModal />);
    fireEvent.click(screen.getByText("Bar"));
    expect(set).toHaveBeenCalledWith("terminal.cursor_style", "bar");
  });

  it("wires the cursor-blink toggle to terminal.cursor_blink", () => {
    const set = vi.fn();
    useSettingsStore.setState({ setConfigValue: set });
    render(<SettingsModal />);
    // Default cursor_blink is true → toggling emits false.
    fireEvent.click(screen.getByLabelText("Cursor blink"));
    expect(set).toHaveBeenCalledWith("terminal.cursor_blink", false);
  });

  it("switches category and wires the Editor soft-wrap toggle to md_editor.soft_wrap", () => {
    const set = vi.fn();
    useSettingsStore.setState({ setConfigValue: set });
    render(<SettingsModal />);
    fireEvent.click(screen.getByText("Editor")); // rail nav → editor category
    fireEvent.click(screen.getByLabelText("Soft wrap"));
    expect(set).toHaveBeenCalledWith("md_editor.soft_wrap", false);
  });

  it("wires the Interface Workflow-tips toggle to prefsStore.setTipsEnabled", () => {
    const setTips = vi.fn();
    usePrefsStore.setState({ tipsEnabled: true, setTipsEnabled: setTips });
    render(<SettingsModal />);
    fireEvent.click(screen.getByText("Interface")); // rail nav → interface category
    fireEvent.click(screen.getByLabelText("Workflow tips"));
    expect(setTips).toHaveBeenCalledWith(false);
  });

  it("wires Reset learned tips to coachStore.resetLearnedTips", () => {
    const reset = vi.fn();
    useCoachStore.setState({ resetLearnedTips: reset });
    render(<SettingsModal />);
    fireEvent.click(screen.getByText("Interface"));
    fireEvent.click(screen.getByText("Reset learned tips"));
    expect(reset).toHaveBeenCalled();
  });
});

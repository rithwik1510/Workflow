// src/lib/pasteFileToPane.test.ts
import { describe, it, expect, beforeEach, vi } from "vitest";

// vi.hoisted so the mocked fns exist before vi.mock's hoisted factory runs —
// the factory closes over them, and a plain `const` would be in the temporal
// dead zone at mock-evaluation time under this vitest version.
const { paste, focusTerminal } = vi.hoisted(() => ({
  paste: vi.fn(),
  focusTerminal: vi.fn(),
}));
vi.mock("@/terminals/registry", () => ({
  getOrCreateTerminal: () => ({ paste }),
  // Since the Plan-012 review fix, pasteFileToPane routes through the guarded
  // paste chokepoint rather than term.paste directly — mock it to the same spy
  // so the assertions below stay about WHAT text is pasted.
  pasteIntoTerminal: (_paneId: string, text: string) => paste(text),
  focusTerminal,
}));

import { pasteFileToPane } from "@/lib/pasteFileToPane";
import { useSessionsStore } from "@/store/sessionsStore";
import { useLayoutStore } from "@/store/layoutStore";

describe("pasteFileToPane", () => {
  beforeEach(() => {
    paste.mockClear();
    focusTerminal.mockClear();
    useSessionsStore.getState().reset();
  });

  it("pastes a session-relative path for a file under the session folder", () => {
    // Seed a session whose layout owns pane-7, rooted at C:\proj.
    const id = useSessionsStore.getState().createSession("C:\\proj", "s");
    useSessionsStore.getState().setLayoutRoot(id, { type: "leaf", paneId: "pane-7" });

    pasteFileToPane("pane-7", "C:\\proj\\src\\auth.ts");

    expect(paste).toHaveBeenCalledWith("src/auth.ts");
    expect(focusTerminal).toHaveBeenCalledWith("pane-7");
  });

  it("pastes the absolute path when the pane has no owning session", () => {
    pasteFileToPane("pane-99", "D:\\ext\\spec.md");
    expect(paste).toHaveBeenCalledWith("D:\\ext\\spec.md");
    // focusPane on an unknown pane is a no-op and must not throw — assert the
    // real layoutStore did not pick up the absent pane as focused.
    expect(useLayoutStore.getState().focusedPaneId).not.toBe("pane-99");
  });
});

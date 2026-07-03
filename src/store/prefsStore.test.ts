import { describe, it, expect, beforeEach, vi } from "vitest";

// persist middleware pulls in plugin-store on import; stub it so no Tauri
// runtime is needed and NO real user config is ever touched.
vi.mock("@tauri-apps/plugin-store", () => ({
  load: vi.fn(async () => ({
    get: vi.fn(async () => null),
    set: vi.fn(async () => undefined),
    delete: vi.fn(async () => undefined),
  })),
}));

import { usePrefsStore } from "@/store/prefsStore";

beforeEach(() => {
  usePrefsStore.getState().reset();
});

describe("prefsStore — behavioral UI preferences", () => {
  it("seeds the operator-locked defaults", () => {
    const s = usePrefsStore.getState();
    expect(s.osNotifications).toBe(true);
    expect(s.toastOnTurnComplete).toBe(false);
  });

  it("toggles the master OS-notifications switch", () => {
    usePrefsStore.getState().setOsNotifications(false);
    expect(usePrefsStore.getState().osNotifications).toBe(false);
    usePrefsStore.getState().setOsNotifications(true);
    expect(usePrefsStore.getState().osNotifications).toBe(true);
  });

  it("toggles the turn-complete toast opt-in", () => {
    usePrefsStore.getState().setToastOnTurnComplete(true);
    expect(usePrefsStore.getState().toastOnTurnComplete).toBe(true);
  });

  it("reset restores both defaults", () => {
    const s = usePrefsStore.getState();
    s.setOsNotifications(false);
    s.setToastOnTurnComplete(true);
    s.reset();
    expect(usePrefsStore.getState().osNotifications).toBe(true);
    expect(usePrefsStore.getState().toastOnTurnComplete).toBe(false);
  });
});

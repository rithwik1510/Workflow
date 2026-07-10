// settingsModalStore — open/close + active category for the Settings panel.
// Mirrors shortcutsModalStore; intentionally tiny (no immer/persist).

import { create } from "zustand";

export type SettingsCategory =
  | "appearance"
  | "terminal"
  | "editor"
  | "sidebar"
  | "agents"
  | "interface";

interface State {
  open: boolean;
  category: SettingsCategory;
}
interface Actions {
  openModal: () => void;
  closeModal: () => void;
  setCategory: (c: SettingsCategory) => void;
}

export const useSettingsModalStore = create<State & Actions>((set) => ({
  open: false,
  category: "appearance",
  openModal: () => set({ open: true }),
  closeModal: () => set({ open: false }),
  setCategory: (category) => set({ category }),
}));

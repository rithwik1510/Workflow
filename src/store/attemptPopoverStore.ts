// attemptPopoverStore — open state + screen anchor for the "New attempt"
// popover (Plan 013 Phase A). Mirrors splitMenuStore: the entry points (session
// row / folder group context menus) read the click coordinates and push them
// here along with the folder to fork; NewAttemptPopover (mounted once in
// App.tsx) reads this and resolves the repo + branches itself.

import { create } from "zustand";

interface AttemptPopoverState {
  open: boolean;
  anchorX: number;
  anchorY: number;
  /** The session/group folder the user forked from — the popover resolves this
   *  to a git repo root on open (and errors inline if it isn't one). */
  folderPath: string;
}

interface AttemptPopoverActions {
  show: (x: number, y: number, folderPath: string) => void;
  close: () => void;
}

export type AttemptPopoverStore = AttemptPopoverState & AttemptPopoverActions;

export const useAttemptPopoverStore = create<AttemptPopoverStore>((set) => ({
  open: false,
  anchorX: 0,
  anchorY: 0,
  folderPath: "",
  show: (x, y, folderPath) => set({ open: true, anchorX: x, anchorY: y, folderPath }),
  close: () => set({ open: false }),
}));

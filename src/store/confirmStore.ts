// src/store/confirmStore.ts
//
// Imperative confirm dialog primitive. Single dialog at a time —
// sequential, not stacked. Callers await a Promise<boolean>; the
// dialog resolves with true on confirm, false on cancel/backdrop/Esc.
//
// Used by pane-close confirmations (CONTEXT.md invariant 3) and any
// future surface that needs a yes/no gate. Lives outside of React so
// non-component code (keyboard shortcuts, store actions) can prompt
// without prop drilling.

import { create } from "zustand";
import { devtools } from "zustand/middleware";

export interface ConfirmRequest {
  title: string;
  message: string;
  /** Optional monospace, newline-preserving block rendered under the message —
   *  e.g. the multiline-paste preview (Plan 012). Scrolls if tall. */
  preview?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** When true, the confirm button is rendered with the danger style and
   *  receives initial focus (so Enter still confirms). Default: cancel
   *  is focused so Enter is the safer "back out" option. */
  danger?: boolean;
}

interface ConfirmState {
  open: boolean;
  request: ConfirmRequest | null;
  _resolve: ((value: boolean) => void) | null;
}

interface ConfirmActions {
  /** Open a confirm dialog and resolve when the user picks. If another
   *  dialog is already open, resolves false immediately (no queue). */
  confirm: (request: ConfirmRequest) => Promise<boolean>;
  /** Internal: called by ConfirmDialog when the user picks. */
  resolve: (value: boolean) => void;
}

export type ConfirmStore = ConfirmState & ConfirmActions;

export const useConfirmStore = create<ConfirmStore>()(
  devtools(
    (set, get) => ({
      open: false,
      request: null,
      _resolve: null,

      confirm: (request) => {
        // Queue policy: if another dialog is open, immediately resolve the
        // new request as false. Keeps UX predictable and avoids reentrant
        // close-pane confirms stomping on each other.
        if (get().open) return Promise.resolve(false);
        return new Promise<boolean>((resolve) => {
          set({ open: true, request, _resolve: resolve });
        });
      },

      resolve: (value) => {
        const r = get()._resolve;
        set({ open: false, request: null, _resolve: null });
        if (r) r(value);
      },
    }),
    { name: "confirmStore" }
  )
);

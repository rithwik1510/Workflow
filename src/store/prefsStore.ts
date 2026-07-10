// prefsStore — small persisted store for BEHAVIORAL UI preferences (Plan 011).
//
// Why a dedicated store: config.toml / settingsStore is schema-locked Rust
// config (serde deny_unknown_fields) — behavioral toggles that only the
// frontend cares about don't belong there. Precedent: Plan 009 put auto-resume
// in paneResumeStore. This is the general home for such prefs, keyed by a flat
// set of named booleans/values so later plans can add keys without a migration
// (Plan 012's paste pref is expected to join here). Keep it generic: one file
// on disk (lume-prefs.json), one version, additive keys only.
//
// Seed values (locked with the operator, Plan 011):
//   - osNotifications: true   — master switch for OS attention escape.
//   - toastOnTurnComplete: false — opt-in upgrade of "your move" to a toast.

import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import { immer } from "zustand/middleware/immer";

import { tauriPersistStorage } from "@/lib/persistStorage";

export interface PrefsState {
  /** Master switch: when OFF, NOTHING escapes the window (no toast, no flash,
   *  no badge). Default ON — the whole point of Plan 011 is that the fleet can
   *  reach you when Lume is minimized. */
  osNotifications: boolean;
  /** When ON, a completed turn ("your move") also raises an OS toast, not just
   *  the badge. Default OFF — turn-complete is calmer than a permission block,
   *  so the toast is opt-in. */
  toastOnTurnComplete: boolean;
  /** When ON (default), pasting text that contains a newline into a terminal
   *  asks first — a stray multiline paste EXECUTES in most shells (Plan 012). */
  warnMultilinePaste: boolean;
  /** Master switch for the workflow coach (Plan 014, default ON). When OFF the
   *  coach is OBSERVATION-off: no chips, no shelf dot, and detectors record
   *  nothing — see coachStore. Toggling off clears any live chip. */
  tipsEnabled: boolean;
}

interface PrefsActions {
  setOsNotifications: (on: boolean) => void;
  setToastOnTurnComplete: (on: boolean) => void;
  setWarnMultilinePaste: (on: boolean) => void;
  setTipsEnabled: (on: boolean) => void;
  reset: () => void;
}

export type PrefsStore = PrefsState & PrefsActions;

const DEFAULTS: PrefsState = {
  osNotifications: true,
  toastOnTurnComplete: false,
  warnMultilinePaste: true,
  tipsEnabled: true,
};

export const usePrefsStore = create<PrefsStore>()(
  persist(
    immer((set) => ({
      ...DEFAULTS,

      setOsNotifications: (on) =>
        set((s) => {
          s.osNotifications = on;
        }),

      setToastOnTurnComplete: (on) =>
        set((s) => {
          s.toastOnTurnComplete = on;
        }),

      setWarnMultilinePaste: (on) =>
        set((s) => {
          s.warnMultilinePaste = on;
        }),

      setTipsEnabled: (on) =>
        set((s) => {
          s.tipsEnabled = on;
        }),

      reset: () =>
        set((s) => {
          s.osNotifications = DEFAULTS.osNotifications;
          s.toastOnTurnComplete = DEFAULTS.toastOnTurnComplete;
          s.warnMultilinePaste = DEFAULTS.warnMultilinePaste;
          s.tipsEnabled = DEFAULTS.tipsEnabled;
        }),
    })),
    {
      name: "prefs",
      storage: createJSONStorage(() => tauriPersistStorage("lume-prefs.json")),
      version: 1,
      // Explicit allow-list: only known behavioral prefs persist. A key added
      // in a later plan must be added here too (keeps the on-disk file tidy).
      partialize: (state) => ({
        osNotifications: state.osNotifications,
        toastOnTurnComplete: state.toastOnTurnComplete,
        warnMultilinePaste: state.warnMultilinePaste,
        tipsEnabled: state.tipsEnabled,
      }),
    }
  )
);

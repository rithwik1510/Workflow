// attentionClient — thin, best-effort wrappers over the OS attention surfaces
// (Plan 011). The decision logic lives in sessions/attentionEscape; this file
// only performs the effects, so every call swallows its errors: attention must
// NEVER crash the app, and a failed toast/badge/flash simply does nothing.
//
// - Badge + flash: our Rust commands (attention.rs), invoked over IPC.
// - Toast: the notification plugin's JS API (sendNotification), because the
//   decision that produced it already lives in TS.

import { invoke } from "@tauri-apps/api/core";
import {
  sendNotification,
  isPermissionGranted,
  requestPermission,
} from "@tauri-apps/plugin-notification";

/** Set (count > 0) or clear (count === 0) the taskbar overlay badge. */
export async function setNeedsYouBadge(count: number): Promise<void> {
  try {
    await invoke("set_needs_you_badge", { count });
  } catch (err) {
    console.warn("attention: set_needs_you_badge failed", err);
  }
}

/** Flash the taskbar button once (focus-preserving). */
export async function flashTaskbar(): Promise<void> {
  try {
    await invoke("flash_taskbar");
  } catch (err) {
    console.warn("attention: flash_taskbar failed", err);
  }
}

/** Ensure notification permission once (called at wiring install). Resolves to
 *  whether toasts are allowed; never throws. */
export async function ensureNotificationPermission(): Promise<boolean> {
  try {
    if (await isPermissionGranted()) return true;
    const state = await requestPermission();
    return state === "granted";
  } catch (err) {
    console.warn("attention: notification permission check failed", err);
    return false;
  }
}

/** Send one OS toast. Best-effort — a denied/unavailable notification is a
 *  no-op, not an error. */
export async function sendToast(title: string, body: string): Promise<void> {
  try {
    sendNotification({ title, body });
  } catch (err) {
    console.warn("attention: sendToast failed", err);
  }
}

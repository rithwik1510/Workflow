// Editor external-change watcher bridge. Mirrors src-tauri/src/editor_watch.rs.
//
// Each open Editor tab registers its path (watchEditorFile) so the Rust
// `notify` watcher reports on-disk changes as a `file-changed` event. The
// store subscribes once via installEditorWatchBridge and decides — per tab —
// whether the change is a silent reload, a conflict, or its own save echoing
// back (self-write suppression lives in mdStore).

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export function watchEditorFile(path: string): Promise<void> {
  return invoke<void>("watch_editor_file", { path });
}

export function unwatchEditorFile(path: string): Promise<void> {
  return invoke<void>("unwatch_editor_file", { path });
}

interface FileChangedPayload {
  path: string;
}

/** Subscribe to the Rust `file-changed` stream. Returns a promise of the
 *  unlisten fn (Tauri's listen is async). Errors are the caller's to handle. */
export function onEditorFileChanged(
  cb: (path: string) => void
): Promise<UnlistenFn> {
  return listen<FileChangedPayload>("file-changed", (e) => cb(e.payload.path));
}

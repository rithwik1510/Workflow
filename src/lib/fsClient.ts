import { invoke } from "@tauri-apps/api/core";
import type { DirEntry } from "@/types/fs";

export function listDir(path: string): Promise<DirEntry[]> {
  return invoke<DirEntry[]>("list_dir", { path });
}

export function readTextFile(path: string): Promise<string> {
  return invoke<string>("read_text_file", { path });
}

/** Probe + read a file for the Editor (Plan 010 §2). `binary` files should be
 *  refused with a toast; `tooLarge` files open read-only with a banner. */
export interface EditorFile {
  content: string;
  size: number;
  tooLarge: boolean;
  binary: boolean;
}

export function readEditorFile(path: string): Promise<EditorFile> {
  return invoke<EditorFile>("read_editor_file", { path });
}

export function writeTextFile(path: string, contents: string): Promise<void> {
  return invoke<void>("write_text_file", { path, contents });
}

export function homeDir(): Promise<string> {
  return invoke<string>("home_dir");
}

/** True if `path` is a readable directory. There's no dedicated exists command,
 *  so we lean on list_dir (which canonicalizes + read_dir's the path and rejects
 *  if it's missing or not a directory). Used at boot to gate agent auto-resume
 *  on the pane's recorded cwd still existing — a bounded, once-per-pane check. */
export async function dirExists(path: string): Promise<boolean> {
  try {
    await listDir(path);
    return true;
  } catch {
    return false;
  }
}

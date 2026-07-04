// src/lib/pasteFileToPane.ts
//
// The one primitive both drag sources call. Resolves the pane's owning session
// folder, formats the path (attachPath), and routes it through the terminal
// paste CHOKEPOINT (pasteIntoTerminal) — onData → PTY with bracketed-paste
// handling, gated by the multiline-paste guard like every other paste. A
// formatted path can't contain a newline today, but the guard invariant is
// structural: no paste path may bypass it (Plan 012).
// No trailing newline: the path lands at the prompt and the user keeps typing.

import { formatAttachPath } from "@/lib/attachPath";
import { getOrCreateTerminal, pasteIntoTerminal, focusTerminal } from "@/terminals/registry";
import { useLayoutStore } from "@/store/layoutStore";
import { useSessionsStore, findSessionForPane } from "@/store/sessionsStore";
import type { PaneId } from "@/types";

export function pasteFileToPane(paneId: PaneId, filePath: string): void {
  const session = findSessionForPane(useSessionsStore.getState(), paneId);
  const folder = session?.folderPath ?? null;
  const text = formatAttachPath(filePath, folder);
  getOrCreateTerminal(paneId); // ensure the Terminal exists before pasting
  pasteIntoTerminal(paneId, text);
  useLayoutStore.getState().focusPane(paneId);
  focusTerminal(paneId);
}

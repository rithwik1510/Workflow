// src/terminals/webLinkHandler.ts
//
// Ctrl+click activation for http(s) URLs printed in terminal output (Plan 012),
// used by @xterm/addon-web-links. Two hard rules:
//
//   1. Ctrl/Cmd+click ONLY. A plain click belongs to the shell's mouse modes —
//      agents and TUIs (Claude Code, vim, …) use mouse reporting, and stealing
//      their clicks would break them. Mirrors mdLinkProvider's gesture gate.
//   2. The webview must NEVER navigate. We hand the URL to the OS opener; there
//      is no window.open / location path (CSP would block it anyway, and a
//      navigation would replace the whole app).
//
// http/https only — the addon underlines other schemes, but the handler refuses
// anything else so a click can't launch, say, a file:// or custom-scheme URI.

/** True when the modifier gesture qualifies to follow the link. */
export function shouldActivateWebLink(event: { ctrlKey: boolean; metaKey: boolean }): boolean {
  return event.ctrlKey || event.metaKey;
}

/**
 * Activation handler passed to WebLinksAddon. `open` is the injected OS opener
 * (openExternal in production, a spy in tests). Returns nothing; on any
 * disqualifying condition it simply does not open — and never navigates.
 */
export function handleWebLink(
  event: { ctrlKey: boolean; metaKey: boolean },
  uri: string,
  open: (url: string) => void
): void {
  if (!shouldActivateWebLink(event)) return;
  if (!/^https?:\/\//i.test(uri)) return;
  open(uri);
}

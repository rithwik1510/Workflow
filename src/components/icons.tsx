// Custom icon set — thin stroke (Lucide/Feather family) so the glyphs read
// crisp and consistent, and `stroke="currentColor"` so they inherit the
// button's colour automatically: --fg-1 at rest, --fg-0 on hover, --accent
// (amber) when a toggle is active. Replaces the OS emoji we used to render,
// which were colourful, off-theme, and rendered at different sizes per font.
//
// Every icon takes `size` (px, default 16) and an optional `strokeWidth`.
// viewBox is a 24-grid; stroke caps/joins are rounded for a soft, premium feel.

import type { PropsWithChildren } from "react";

export interface IconProps {
  size?: number;
  strokeWidth?: number;
}

function Stroke({ size = 16, strokeWidth = 1.75, children }: PropsWithChildren<IconProps>) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

/** Toggle sessions sidebar — a panel with a left rail. */
export function IconSidebar(props: IconProps) {
  return (
    <Stroke {...props}>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <line x1="9" y1="4" x2="9" y2="20" />
    </Stroke>
  );
}

/** Toggle file drawer — a folder. */
export function IconFolder(props: IconProps) {
  return (
    <Stroke {...props}>
      <path d="M4 7a2 2 0 0 1 2-2h3.2a2 2 0 0 1 1.4.6L12 7h6a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z" />
    </Stroke>
  );
}

/** Open folder — switch/create a session (an open folder). */
export function IconFolderOpen(props: IconProps) {
  return (
    <Stroke {...props}>
      <path d="M4 19V6a2 2 0 0 1 2-2h3.2a2 2 0 0 1 1.4.6L12 6h6a2 2 0 0 1 2 2v1" />
      <path d="M2.7 12.4A1 1 0 0 1 3.65 11H21a1 1 0 0 1 .96 1.27l-1.7 6A1 1 0 0 1 19.3 19H4a1 1 0 0 1-1-1z" />
    </Stroke>
  );
}

/** Split focused pane — two columns. */
export function IconSplit(props: IconProps) {
  return (
    <Stroke {...props}>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <line x1="12" y1="4" x2="12" y2="20" />
    </Stroke>
  );
}

/** Keyboard shortcuts. */
export function IconKeyboard(props: IconProps) {
  return (
    <Stroke {...props}>
      <rect x="2" y="6" width="20" height="12" rx="2" />
      <line x1="6" y1="10" x2="6" y2="10" />
      <line x1="10" y1="10" x2="10" y2="10" />
      <line x1="14" y1="10" x2="14" y2="10" />
      <line x1="18" y1="10" x2="18" y2="10" />
      <line x1="9" y1="14" x2="15" y2="14" />
    </Stroke>
  );
}

/** MD editor (full view) — a square with a pen: "edit". */
export function IconEdit(props: IconProps) {
  return (
    <Stroke {...props}>
      <path d="M11 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-5" />
      <path d="M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4z" />
    </Stroke>
  );
}

/** Save — disk-style document action. */
export function IconSave(props: IconProps) {
  return (
    <Stroke {...props}>
      <path d="M5 3h12l2 2v16H5z" />
      <path d="M8 3v6h8V3" />
      <path d="M8 21v-7h8v7" />
    </Stroke>
  );
}

/** Quick viewer (read-only preview) — an eye. */
export function IconEye(props: IconProps) {
  return (
    <Stroke {...props}>
      <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z" />
      <circle cx="12" cy="12" r="3" />
    </Stroke>
  );
}

/** Localhost preview (web view) — a globe. */
export function IconGlobe(props: IconProps) {
  return (
    <Stroke {...props}>
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18" />
      <path d="M12 3a14 14 0 0 1 0 18a14 14 0 0 1 0-18Z" />
    </Stroke>
  );
}

/** Diff — git-compare: two branch nodes joined by a curved path (review view). */
export function IconDiff(props: IconProps) {
  return (
    <Stroke {...props}>
      <circle cx="6" cy="6" r="2.5" />
      <circle cx="18" cy="18" r="2.5" />
      <path d="M6 8.5v6a3 3 0 0 0 3 3h6" />
      <path d="M18 15.5v-6a3 3 0 0 0-3-3H9" />
    </Stroke>
  );
}

/** Refresh — a circular arrow (re-list the diff). */
export function IconRefresh(props: IconProps) {
  return (
    <Stroke {...props}>
      <path d="M3 12a9 9 0 0 1 15.5-6.3L21 8" />
      <path d="M21 3v5h-5" />
      <path d="M21 12a9 9 0 0 1-15.5 6.3L3 16" />
      <path d="M3 21v-5h5" />
    </Stroke>
  );
}

/** Settings — a gear. */
export function IconSettings(props: IconProps) {
  return (
    <Stroke {...props}>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </Stroke>
  );
}

/** Overflow menu — three dots (filled). */
export function IconEllipsis({ size = 16 }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      stroke="none"
      aria-hidden="true"
      focusable="false"
    >
      <circle cx="5" cy="12" r="1.6" />
      <circle cx="12" cy="12" r="1.6" />
      <circle cx="19" cy="12" r="1.6" />
    </svg>
  );
}

/** Plus — for "new" actions. */
export function IconPlus(props: IconProps) {
  return (
    <Stroke {...props}>
      <line x1="12" y1="5" x2="12" y2="19" />
      <line x1="5" y1="12" x2="19" y2="12" />
    </Stroke>
  );
}

/** Directional arrows — used by the split-pane popover. */
export function IconArrowRight(props: IconProps) {
  return (
    <Stroke {...props}>
      <line x1="5" y1="12" x2="19" y2="12" />
      <polyline points="12 5 19 12 12 19" />
    </Stroke>
  );
}
export function IconArrowUp(props: IconProps) {
  return (
    <Stroke {...props}>
      <line x1="12" y1="19" x2="12" y2="5" />
      <polyline points="5 12 12 5 19 12" />
    </Stroke>
  );
}
export function IconArrowDown(props: IconProps) {
  return (
    <Stroke {...props}>
      <line x1="12" y1="5" x2="12" y2="19" />
      <polyline points="19 12 12 19 5 12" />
    </Stroke>
  );
}

/** Chevron (points down). Group carets rotate this -90° when collapsed. */
export function IconChevron(props: IconProps) {
  return (
    <Stroke {...props}>
      <polyline points="6 9 12 15 18 9" />
    </Stroke>
  );
}

/** Git branch — a branch splitting off a trunk. Marks base branches in the
 *  New Attempt base picker (Plan 013). */
export function IconGitBranch(props: IconProps) {
  return (
    <Stroke {...props}>
      <line x1="6" y1="3" x2="6" y2="15" />
      <circle cx="18" cy="6" r="3" />
      <circle cx="6" cy="18" r="3" />
      <path d="M18 9a9 9 0 0 1-9 9" />
    </Stroke>
  );
}

/** Search — magnifying glass. Used as a leading icon inside filter inputs. */
export function IconSearch(props: IconProps) {
  return (
    <Stroke {...props}>
      <circle cx="11" cy="11" r="7" />
      <line x1="20" y1="20" x2="16.65" y2="16.65" />
    </Stroke>
  );
}

/** File — generic document with a folded corner. The SidebarRow uses this for
 *  every file leaf; the parent component differentiates .md (with extra
 *  content lines) via IconFileText. */
export function IconFile(props: IconProps) {
  return (
    <Stroke {...props}>
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
    </Stroke>
  );
}

/** File with text lines inside — a content-bearing document (.md). The lines
 *  read as "this file has substance" vs. an empty stub. */
export function IconFileText(props: IconProps) {
  return (
    <Stroke {...props}>
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
      <line x1="8" y1="13" x2="14" y2="13" />
      <line x1="8" y1="17" x2="13" y2="17" />
    </Stroke>
  );
}

/** Trash can — delete actions (session/group). */
export function IconTrash(props: IconProps) {
  return (
    <Stroke {...props}>
      <polyline points="3 6 5 6 21 6" />
      <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
      <line x1="10" y1="11" x2="10" y2="17" />
      <line x1="14" y1="11" x2="14" y2="17" />
      <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
    </Stroke>
  );
}

/** Pane zoom (PaneTree corner cluster): diagonal out-arrows — "make this pane
 *  fill the session". Pairs with IconContract for the restore state. */
export function IconExpand({ size = 14, strokeWidth = 1.75 }: IconProps) {
  return (
    <Stroke size={size} strokeWidth={strokeWidth}>
      <polyline points="14 5 19 5 19 10" />
      <line x1="19" y1="5" x2="13.5" y2="10.5" />
      <polyline points="10 19 5 19 5 14" />
      <line x1="5" y1="19" x2="10.5" y2="13.5" />
    </Stroke>
  );
}

/** Pane zoom restore: diagonal in-arrows — "give the other panes back". */
export function IconContract({ size = 14, strokeWidth = 1.75 }: IconProps) {
  return (
    <Stroke size={size} strokeWidth={strokeWidth}>
      <polyline points="13.5 6 13.5 10.5 18 10.5" />
      <line x1="19" y1="5" x2="13.5" y2="10.5" />
      <polyline points="10.5 18 10.5 13.5 6 13.5" />
      <line x1="5" y1="19" x2="10.5" y2="13.5" />
    </Stroke>
  );
}

// ── Window controls (frameless titlebar). Kept here so all titlebar glyphs
//    live in one place; TopBar imports these too. ──────────────────────────

export function IconMinimize({ size = 14, strokeWidth = 1.75 }: IconProps) {
  return (
    <Stroke size={size} strokeWidth={strokeWidth}>
      <line x1="5" y1="12" x2="19" y2="12" />
    </Stroke>
  );
}

export function IconMaximize({ size = 14, strokeWidth = 1.75 }: IconProps) {
  return (
    <Stroke size={size} strokeWidth={strokeWidth}>
      <rect x="5" y="5" width="14" height="14" rx="1.5" />
    </Stroke>
  );
}

export function IconClose({ size = 14, strokeWidth = 1.75 }: IconProps) {
  return (
    <Stroke size={size} strokeWidth={strokeWidth}>
      <line x1="6" y1="6" x2="18" y2="18" />
      <line x1="18" y1="6" x2="6" y2="18" />
    </Stroke>
  );
}

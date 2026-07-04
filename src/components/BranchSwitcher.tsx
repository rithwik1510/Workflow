// BranchSwitcher — the status bar's persistent branch control (extends Plan
// 013). The `⎇ <branch>` that used to be static text is a chip; clicking it
// opens an UPWARD picker of every branch (locals then remotes, current marked,
// "open" tag on branches some worktree already has). Selecting one goes to a
// terminal ON that branch — the Conductor/Codex-app feel — via openBranch,
// which NEVER checks out in place (it jumps to the existing worktree's session
// or creates a fresh worktree + session; running agents are never disturbed).
//
// Chrome follows the app's popover language (NewAttemptPopover/LandMenu):
// usePresence, var() fallbacks everywhere, reduced-motion safe, Esc + click-
// outside close, type-to-filter with the input autofocused.

import { useEffect, useRef, useState } from "react";

import styles from "@/components/BranchSwitcher.module.css";
import { IconGitBranch, IconSearch } from "@/components/icons";
import { usePresence } from "@/hooks/usePresence";
import {
  gitListBranches,
  gitRepoRoot,
  gitWorktreeList,
  type BranchInfo,
} from "@/lib/gitClient";
import { basename } from "@/lib/sessions/groupingHelpers";
import { openBranch, localBranchName } from "@/sessions/openBranch";
import { useSessionsStore } from "@/store/sessionsStore";

export function BranchSwitcher() {
  const session = useSessionsStore((s) =>
    s.activeSessionId ? s.sessions[s.activeSessionId] ?? null : null
  );
  const [open, setOpen] = useState(false);
  const chipRef = useRef<HTMLButtonElement | null>(null);
  const { mounted, state } = usePresence(open, 120);

  const branch = session?.gitBranch ?? null;
  if (!session || !branch) return null;

  return (
    <>
      <button
        ref={chipRef}
        type="button"
        className={styles.chip}
        title="Switch branch — opens in its own terminal"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        {`⎇ ${branch}`}
      </button>
      {mounted && (
        <Picker
          key={`${session.id}:${branch}`}
          folderPath={session.folderPath}
          currentBranch={branch}
          anchorRef={chipRef}
          dataState={state}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}

type Phase = "loading" | "ready" | "notRepo" | "error";

function Picker({
  folderPath,
  currentBranch,
  anchorRef,
  dataState,
  onClose,
}: {
  folderPath: string;
  currentBranch: string;
  anchorRef: React.RefObject<HTMLButtonElement | null>;
  dataState: "open" | "closed";
  onClose: () => void;
}) {
  const cardRef = useRef<HTMLDivElement | null>(null);
  const filterRef = useRef<HTMLInputElement | null>(null);
  const [phase, setPhase] = useState<Phase>("loading");
  const [repoRoot, setRepoRoot] = useState("");
  const [branches, setBranches] = useState<BranchInfo[]>([]);
  const [openBranches, setOpenBranches] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState("");

  // Resolve the live picture on open: the repo, its branches, and which
  // branches already have a worktree (those JUMP instead of creating).
  useEffect(() => {
    let alive = true;
    void (async () => {
      const root = await gitRepoRoot(folderPath).catch(() => null);
      if (!alive) return;
      if (!root) {
        setPhase("notRepo");
        return;
      }
      setRepoRoot(root);
      const [list, worktrees] = await Promise.all([
        gitListBranches(root).catch(() => [] as BranchInfo[]),
        gitWorktreeList(root).catch(() => []),
      ]);
      if (!alive) return;
      setBranches(list);
      setOpenBranches(
        new Set(worktrees.map((w) => w.branch).filter((b): b is string => b !== null))
      );
      setPhase(list.length > 0 ? "ready" : "error");
    })();
    return () => {
      alive = false;
    };
  }, [folderPath]);

  useEffect(() => {
    filterRef.current?.focus();
  }, [phase]);

  // Esc (capture, so it wins over xterm) + click-outside close. The chip is
  // part of "inside" — its own onClick handles the toggle.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    };
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (cardRef.current?.contains(t)) return;
      if (anchorRef.current?.contains(t)) return;
      onClose();
    };
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("pointerdown", onDown, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("pointerdown", onDown, true);
    };
  }, [onClose, anchorRef]);

  // Anchor the card just ABOVE the chip, clamped into the viewport.
  const rect = anchorRef.current?.getBoundingClientRect();
  const pad = 8;
  const left = Math.max(pad, Math.min(rect?.left ?? pad, window.innerWidth - 280 - pad));
  const bottom = window.innerHeight - (rect?.top ?? window.innerHeight) + 6;

  const q = filter.trim().toLowerCase();
  const match = (b: BranchInfo) => q === "" || b.name.toLowerCase().includes(q);
  const locals = branches.filter((b) => !b.isRemote && match(b));
  const remotes = branches.filter((b) => b.isRemote && match(b));

  const select = (b: BranchInfo) => {
    onClose();
    if (!b.isRemote && b.name === currentBranch) return; // already here
    void openBranch(repoRoot, basename(repoRoot), { name: b.name, isRemote: b.isRemote });
  };

  const row = (b: BranchInfo) => (
    <button
      key={b.name}
      type="button"
      className={styles.row}
      role="option"
      aria-selected={!b.isRemote && b.name === currentBranch}
      onClick={() => select(b)}
    >
      <span className={styles.rowIcon}>
        <IconGitBranch size={11} />
      </span>
      <span className={styles.rowName}>{b.name}</span>
      {!b.isRemote && b.name === currentBranch ? (
        <span className={styles.current}>current</span>
      ) : openBranches.has(localBranchName({ name: b.name, isRemote: b.isRemote })) ? (
        <span className={styles.openTag}>open</span>
      ) : null}
    </button>
  );

  return (
    <div
      ref={cardRef}
      className={styles.card}
      data-state={dataState}
      style={{ left, bottom }}
      role="listbox"
      aria-label="Switch branch"
    >
      <div className={styles.filterRow}>
        <IconSearch size={12} />
        <input
          ref={filterRef}
          className={styles.filterInput}
          value={filter}
          placeholder="Switch branch…"
          spellCheck={false}
          autoComplete="off"
          onChange={(e) => setFilter(e.target.value)}
        />
      </div>
      <div className={styles.list}>
        {phase === "loading" && <div className={styles.empty}>Loading branches…</div>}
        {phase === "notRepo" && <div className={styles.empty}>Not a git repository.</div>}
        {phase === "error" && <div className={styles.empty}>Couldn’t list branches.</div>}
        {phase === "ready" && (
          <>
            {locals.map(row)}
            {remotes.length > 0 && <div className={styles.section}>Remote</div>}
            {remotes.map(row)}
            {locals.length === 0 && remotes.length === 0 && (
              <div className={styles.empty}>No branches match.</div>
            )}
          </>
        )}
      </div>
      <div className={styles.footer}>
        Opens in its own worktree — running agents are never disturbed.
      </div>
    </div>
  );
}

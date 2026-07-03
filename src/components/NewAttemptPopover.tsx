// NewAttemptPopover — the "New attempt" creation surface (Plan 013 Phase A).
//
// Forks a repo session into an isolated git worktree: the user names the
// attempt (live slug preview), picks a base branch to fork from, and hits
// Create — which runs `git worktree add`, spins up a session on the new folder
// grouped under the repo, and records the attempt. This is a QUALITY-BAR item:
// it must feel indistinguishable from the rest of the app (presence animation,
// var() fallbacks on every custom property, reduced-motion safe, the accent
// used exactly once on the primary action).
//
// Anchored like SplitMenu (fixed at the click coordinates, clamped into view).
// Branches are fetched on open with inline loading/error states. Creation
// failure keeps the popover open and shows git's stderr VERBATIM — git's
// messages are precise and we never paraphrase them.

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import styles from "@/components/NewAttemptPopover.module.css";
import { IconGitBranch, IconSearch, IconChevron } from "@/components/icons";
import { usePresence } from "@/hooks/usePresence";
import { homeDir } from "@/lib/fsClient";
import { gitRepoRoot, gitListBranches, gitDefaultBranch, type BranchInfo } from "@/lib/gitClient";
import { basename, samePath } from "@/lib/sessions/groupingHelpers";
import {
  attemptPaths,
  createAttempt,
  shortenHomePath,
  slugify,
  suggestAttemptName,
  BRANCH_PREFIX,
} from "@/sessions/attemptCreate";
import { useAttemptStore } from "@/store/attemptStore";
import { useAttemptPopoverStore } from "@/store/attemptPopoverStore";

/** Pull git's verbatim message out of a rejected worktree-add (AppError carries
 *  `reason`), falling back to a plain stringify. */
function gitErrorText(err: unknown): string {
  if (
    err &&
    typeof err === "object" &&
    "reason" in err &&
    typeof (err as { reason?: unknown }).reason === "string"
  ) {
    return (err as { reason: string }).reason;
  }
  return err instanceof Error ? err.message : String(err);
}

type Phase = "loading" | "ready" | "notRepo";

export function NewAttemptPopover() {
  const open = useAttemptPopoverStore((s) => s.open);
  const anchorX = useAttemptPopoverStore((s) => s.anchorX);
  const anchorY = useAttemptPopoverStore((s) => s.anchorY);
  const folderPath = useAttemptPopoverStore((s) => s.folderPath);
  const close = useAttemptPopoverStore((s) => s.close);
  const { mounted, state } = usePresence(open, 140);

  if (!mounted) return null;
  return (
    <Panel
      key={folderPath + anchorX + anchorY}
      folderPath={folderPath}
      anchorX={anchorX}
      anchorY={anchorY}
      dataState={state}
      onClose={close}
    />
  );
}

// Split so the whole form's state is freshly created each time the popover
// opens (keyed by the anchor) — no stale name/branch bleeding across opens.
function Panel({
  folderPath,
  anchorX,
  anchorY,
  dataState,
  onClose,
}: {
  folderPath: string;
  anchorX: number;
  anchorY: number;
  dataState: "open" | "closed";
  onClose: () => void;
}) {
  const cardRef = useRef<HTMLDivElement | null>(null);
  const nameRef = useRef<HTMLInputElement | null>(null);

  const [phase, setPhase] = useState<Phase>("loading");
  const [repoRoot, setRepoRoot] = useState<string>("");
  const [repoName, setRepoName] = useState<string>("");
  const [home, setHome] = useState<string>("");
  const [branches, setBranches] = useState<BranchInfo[]>([]);
  const [name, setName] = useState("");
  const [baseBranch, setBaseBranch] = useState("");

  const [pickerOpen, setPickerOpen] = useState(false);
  const [filter, setFilter] = useState("");

  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  // Clamp the card into the viewport once it's measured (a tall form anchored
  // near the bottom/right edge would otherwise clip).
  const [pos, setPos] = useState<{ left: number; top: number }>({ left: anchorX, top: anchorY });
  useLayoutEffect(() => {
    const el = cardRef.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    const pad = 8;
    const left = Math.max(pad, Math.min(anchorX, window.innerWidth - width - pad));
    const top = Math.max(pad, Math.min(anchorY, window.innerHeight - height - pad));
    setPos({ left, top });
  }, [anchorX, anchorY, phase, branches.length]);

  // Resolve the repo + branches + home on open. Every entry point hands us a
  // session/group folder; it may be a subdir of a repo (or not a repo at all).
  useEffect(() => {
    let alive = true;
    void (async () => {
      const root = await gitRepoRoot(folderPath).catch(() => null);
      if (!alive) return;
      if (!root) {
        setPhase("notRepo");
        return;
      }
      const rname = basename(root);
      setRepoRoot(root);
      setRepoName(rname);
      const [list, def, h] = await Promise.all([
        gitListBranches(root).catch(() => [] as BranchInfo[]),
        gitDefaultBranch(root).catch(() => null),
        homeDir().catch(() => ""),
      ]);
      if (!alive) return;
      setBranches(list);
      setHome(h);
      // Preselect the default branch (fall back to the current, then the first).
      const preferred =
        (def && list.find((b) => b.name === def)?.name) ??
        list.find((b) => b.isCurrent)?.name ??
        list[0]?.name ??
        def ??
        "";
      setBaseBranch(preferred);
      // Prefill a non-colliding name against this repo's existing attempts.
      const takenSlugs = Object.values(useAttemptStore.getState().attempts)
        .filter((a) => samePath(a.repoRoot, root))
        .map((a) => a.branch.slice(BRANCH_PREFIX.length));
      setName(suggestAttemptName(rname, takenSlugs));
      setPhase("ready");
    })();
    return () => {
      alive = false;
    };
  }, [folderPath]);

  // Autofocus + select the name once the form is ready (so a quick rename is one
  // keystroke away).
  useEffect(() => {
    if (phase === "ready") {
      nameRef.current?.focus();
      nameRef.current?.select();
    }
  }, [phase]);

  // Escape closes; click-outside closes. Capture phase so Esc wins over xterm.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        if (pickerOpen) setPickerOpen(false);
        else onClose();
      }
    };
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node | null;
      if (cardRef.current && target && !cardRef.current.contains(target)) onClose();
    };
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("mousedown", onDown);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("mousedown", onDown);
    };
  }, [onClose, pickerOpen]);

  const slug = useMemo(() => slugify(name), [name]);
  const branch = `${BRANCH_PREFIX}${slug}`;
  const previewPath = useMemo(() => {
    if (!home || !repoName) return "";
    return shortenHomePath(attemptPaths(home, repoName, slug).worktreePath, home);
  }, [home, repoName, slug]);

  const filteredBranches = useMemo(() => {
    const f = filter.trim().toLowerCase();
    if (!f) return branches;
    return branches.filter((b) => b.name.toLowerCase().includes(f));
  }, [branches, filter]);

  const canCreate = phase === "ready" && !!baseBranch && !!name.trim() && !creating;

  const onCreate = async () => {
    if (!canCreate) return;
    setCreating(true);
    setCreateError(null);
    try {
      await createAttempt({ repoRoot, repoName, baseBranch, attemptName: name });
      onClose();
    } catch (err) {
      // Keep the popover open; show git's own words verbatim.
      setCreateError(gitErrorText(err));
      setCreating(false);
    }
  };

  return (
    <div
      ref={cardRef}
      className={styles.card}
      data-state={dataState}
      style={{ left: pos.left, top: pos.top }}
      role="dialog"
      aria-label="New attempt"
    >
      <div className={styles.title}>New attempt</div>

      {phase === "notRepo" ? (
        <>
          <div className={styles.notRepo}>
            This folder isn&rsquo;t a git repository, so there&rsquo;s nothing to fork.
          </div>
          <div className={styles.actions}>
            <button type="button" className={styles.btn} onClick={onClose}>
              Close
            </button>
          </div>
        </>
      ) : (
        <>
          <label className={styles.field}>
            <span className={styles.label}>Name</span>
            <input
              ref={nameRef}
              className={styles.input}
              value={name}
              spellCheck={false}
              placeholder={phase === "loading" ? "Loading…" : "attempt name"}
              disabled={phase !== "ready"}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !pickerOpen) {
                  e.preventDefault();
                  void onCreate();
                }
              }}
            />
          </label>

          <div className={styles.field}>
            <span className={styles.label}>Base branch</span>
            <button
              type="button"
              className={styles.select}
              disabled={phase !== "ready"}
              onClick={() => setPickerOpen((v) => !v)}
              aria-haspopup="listbox"
              aria-expanded={pickerOpen}
            >
              <IconGitBranch size={13} />
              <span className={styles.selectName}>
                {phase === "loading"
                  ? "Loading branches…"
                  : baseBranch || (branches.length === 0 ? "No branches found" : "Select a branch")}
              </span>
              <IconChevron size={13} />
            </button>
            {pickerOpen && phase === "ready" && (
              <div className={styles.picker} role="listbox" aria-label="Base branch">
                <div className={styles.pickerSearch}>
                  <IconSearch size={13} />
                  <input
                    className={styles.pickerInput}
                    value={filter}
                    autoFocus
                    spellCheck={false}
                    placeholder="Filter branches…"
                    onChange={(e) => setFilter(e.target.value)}
                  />
                </div>
                <div className={styles.pickerList}>
                  {filteredBranches.length === 0 ? (
                    <div className={styles.pickerEmpty}>No matching branches</div>
                  ) : (
                    filteredBranches.map((b) => (
                      <button
                        type="button"
                        key={(b.isRemote ? "r:" : "l:") + b.name}
                        className={`${styles.pickerItem} ${
                          b.name === baseBranch ? styles.pickerItemActive : ""
                        }`}
                        role="option"
                        aria-selected={b.name === baseBranch}
                        onClick={() => {
                          setBaseBranch(b.name);
                          setPickerOpen(false);
                          setFilter("");
                        }}
                      >
                        <IconGitBranch size={12} />
                        <span className={styles.pickerItemName}>{b.name}</span>
                        {b.isCurrent && <span className={styles.pickerTag}>current</span>}
                        {b.isRemote && <span className={styles.pickerTag}>remote</span>}
                      </button>
                    ))
                  )}
                </div>
              </div>
            )}
          </div>

          {/* Quiet preview: the branch + where the worktree will live. */}
          <div className={styles.preview} title={previewPath}>
            <span className={styles.previewBranch}>{branch}</span>
            {previewPath && (
              <>
                <span className={styles.previewDot}>·</span>
                <span className={styles.previewPath}>{previewPath}</span>
              </>
            )}
          </div>

          {createError && <div className={styles.error}>{createError}</div>}

          <div className={styles.actions}>
            <button type="button" className={styles.btn} onClick={onClose} disabled={creating}>
              Cancel
            </button>
            <button
              type="button"
              className={`${styles.btn} ${styles.primary}`}
              onClick={() => void onCreate()}
              disabled={!canCreate}
            >
              {creating ? "Creating…" : "Create attempt"}
            </button>
          </div>
        </>
      )}
    </div>
  );
}

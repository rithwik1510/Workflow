// diffStore — surface open/close + repo/file wiring (Plan 010 Phase B).
//
// git is mocked at the @/lib/gitClient boundary, so these tests pin the store's
// own behaviour: openDiff derives repos from the active session and lists files
// (auto-selecting the first), close flips the flag, setActiveRepo re-lists, and
// a quiet poll refresh never yanks the current selection.

import { describe, it, expect, beforeEach, vi } from "vitest";

// sessionsStore's persist middleware loads plugin-store on import; stub it.
vi.mock("@tauri-apps/plugin-store", () => ({
  load: vi.fn(async () => ({
    get: vi.fn(async () => null),
    set: vi.fn(async () => undefined),
    delete: vi.fn(async () => undefined),
    save: vi.fn(async () => undefined),
  })),
}));

const { rootMap, filesMap, mergeBaseFn } = vi.hoisted(() => ({
  rootMap: new Map<string, string | null>(),
  filesMap: new Map<string, { status: string; path: string; oldPath: string | null }[]>(),
  mergeBaseFn: vi.fn(async () => null as string | null),
}));

vi.mock("@/lib/gitClient", () => ({
  gitRepoRoot: vi.fn(async (p: string) => rootMap.get(p) ?? null),
  gitChangedFiles: vi.fn(async (repo: string) => filesMap.get(repo) ?? []),
  gitFileDiff: vi.fn(),
  gitMergeBase: mergeBaseFn,
  // attemptStore imports this; unused here (reconcile is never called).
  gitWorktreeList: vi.fn(async () => []),
}));

import { gitChangedFiles } from "@/lib/gitClient";
import { useDiffStore } from "@/store/diffStore";
import { useSessionsStore } from "@/store/sessionsStore";
import { useAttemptStore, type Attempt } from "@/store/attemptStore";

function seedActiveSession(folderPath: string): string {
  const id = useSessionsStore.getState().createSession(folderPath);
  useSessionsStore.getState().activateSession(id);
  return id;
}

beforeEach(() => {
  useSessionsStore.setState(useSessionsStore.getInitialState(), true);
  useDiffStore.getState().reset();
  useAttemptStore.getState().reset();
  rootMap.clear();
  filesMap.clear();
  mergeBaseFn.mockReset();
  mergeBaseFn.mockResolvedValue(null);
  vi.mocked(gitChangedFiles).mockClear();
});

const mkAttempt = (over: Partial<Attempt> = {}): Attempt => ({
  repoRoot: "/repo",
  repoName: "repo",
  baseBranch: "main",
  branch: "lume/fix",
  worktreePath: "/repo",
  createdAt: 1,
  hintDismissed: false,
  ...over,
});

describe("diffStore — open / close", () => {
  it("openDiff derives the repo, lists files, and selects the first", async () => {
    seedActiveSession("/repo");
    rootMap.set("/repo", "/repo");
    filesMap.set("/repo", [
      { status: "modified", path: "a.ts", oldPath: null },
      { status: "added", path: "b.ts", oldPath: null },
    ]);

    await useDiffStore.getState().openDiff();

    const s = useDiffStore.getState();
    expect(s.open).toBe(true);
    expect(s.repos).toEqual(["/repo"]);
    expect(s.activeRepo).toBe("/repo");
    expect(s.files.map((f) => f.path)).toEqual(["a.ts", "b.ts"]);
    expect(s.selectedPath).toBe("a.ts"); // first file auto-selected
    expect(s.loading).toBe(false);
  });

  it("closeDiff flips the flag", async () => {
    seedActiveSession("/repo");
    rootMap.set("/repo", "/repo");
    await useDiffStore.getState().openDiff();
    useDiffStore.getState().closeDiff();
    expect(useDiffStore.getState().open).toBe(false);
  });

  it("a session not inside a git repo yields no repos and an empty list", async () => {
    seedActiveSession("/not-a-repo");
    // rootMap has no entry → gitRepoRoot resolves null.
    await useDiffStore.getState().openDiff();
    const s = useDiffStore.getState();
    expect(s.open).toBe(true);
    expect(s.repos).toEqual([]);
    expect(s.activeRepo).toBeNull();
    expect(s.files).toEqual([]);
    expect(s.loading).toBe(false);
  });

  it("no active session yields no repos", async () => {
    // Nothing seeded → activeSessionId null.
    await useDiffStore.getState().openDiff();
    const s = useDiffStore.getState();
    expect(s.repos).toEqual([]);
    expect(s.activeRepo).toBeNull();
    expect(s.loading).toBe(false);
  });
});

describe("diffStore — multi-repo + refresh", () => {
  it("setActiveRepo switches repo and re-lists its files", async () => {
    // Two distinct repos are hard to seed via one folderPath session; drive the
    // store directly: openDiff on repo A, then switch to repo B.
    seedActiveSession("/a");
    rootMap.set("/a", "/a");
    filesMap.set("/a", [{ status: "modified", path: "x.ts", oldPath: null }]);
    filesMap.set("/b", [{ status: "deleted", path: "y.ts", oldPath: null }]);

    await useDiffStore.getState().openDiff();
    expect(useDiffStore.getState().activeRepo).toBe("/a");

    await useDiffStore.getState().setActiveRepo("/b");
    const s = useDiffStore.getState();
    expect(s.activeRepo).toBe("/b");
    expect(s.files.map((f) => f.path)).toEqual(["y.ts"]);
    expect(s.selectedPath).toBe("y.ts");
  });

  it("a quiet refresh keeps the current selection", async () => {
    seedActiveSession("/repo");
    rootMap.set("/repo", "/repo");
    filesMap.set("/repo", [
      { status: "modified", path: "a.ts", oldPath: null },
      { status: "modified", path: "b.ts", oldPath: null },
    ]);
    await useDiffStore.getState().openDiff();
    useDiffStore.getState().selectFile("b.ts");

    await useDiffStore.getState().refresh({ quiet: true });
    expect(useDiffStore.getState().selectedPath).toBe("b.ts"); // not reset to a.ts
  });

  it("a quiet refresh drops a selection whose file is no longer changed", async () => {
    seedActiveSession("/repo");
    rootMap.set("/repo", "/repo");
    filesMap.set("/repo", [
      { status: "modified", path: "a.ts", oldPath: null },
      { status: "modified", path: "gone.ts", oldPath: null },
    ]);
    await useDiffStore.getState().openDiff();
    useDiffStore.getState().selectFile("gone.ts");

    // The file gets committed/reverted away between polls.
    filesMap.set("/repo", [{ status: "modified", path: "a.ts", oldPath: null }]);
    await useDiffStore.getState().refresh({ quiet: true });
    expect(useDiffStore.getState().selectedPath).toBeNull();
  });

  it("setViewMode toggles the layout preference", () => {
    expect(useDiffStore.getState().viewMode).toBe("unified");
    useDiffStore.getState().setViewMode("split");
    expect(useDiffStore.getState().viewMode).toBe("split");
  });
});

describe("diffStore — merge-base (attempt sessions)", () => {
  it("defaults an attempt session to merge-base and lists against the resolved SHA", async () => {
    const id = seedActiveSession("/repo");
    rootMap.set("/repo", "/repo");
    filesMap.set("/repo", [{ status: "added", path: "feat.ts", oldPath: null }]);
    useAttemptStore.getState().addAttempt(id, mkAttempt({ worktreePath: "/repo" }));
    mergeBaseFn.mockResolvedValue("abc123");

    await useDiffStore.getState().openDiff();

    const s = useDiffStore.getState();
    expect(s.baseMode).toBe("mergeBase");
    expect(s.mergeBase).toBe("abc123");
    expect(s.baseBranch).toBe("main");
    expect(s.attemptRepo).toBe("/repo");
    expect(s.activeBase).toBe("abc123");
    // The first file list was taken against the merge-base SHA, not HEAD.
    expect(vi.mocked(gitChangedFiles)).toHaveBeenCalledWith("/repo", "abc123");
  });

  it("toggling to HEAD re-lists against null base", async () => {
    const id = seedActiveSession("/repo");
    rootMap.set("/repo", "/repo");
    filesMap.set("/repo", [{ status: "added", path: "feat.ts", oldPath: null }]);
    useAttemptStore.getState().addAttempt(id, mkAttempt());
    mergeBaseFn.mockResolvedValue("abc123");
    await useDiffStore.getState().openDiff();

    await useDiffStore.getState().setBaseMode("head");

    const s = useDiffStore.getState();
    expect(s.baseMode).toBe("head");
    expect(s.activeBase).toBeNull();
    expect(vi.mocked(gitChangedFiles)).toHaveBeenLastCalledWith("/repo", null);
  });

  it("falls back to HEAD when no merge-base resolves", async () => {
    const id = seedActiveSession("/repo");
    rootMap.set("/repo", "/repo");
    useAttemptStore.getState().addAttempt(id, mkAttempt());
    mergeBaseFn.mockResolvedValue(null); // unrelated histories / bad base

    await useDiffStore.getState().openDiff();

    const s = useDiffStore.getState();
    expect(s.baseMode).toBe("head");
    expect(s.activeBase).toBeNull();
  });

  it("a non-attempt session is HEAD-only (no merge-base probe)", async () => {
    seedActiveSession("/repo");
    rootMap.set("/repo", "/repo");

    await useDiffStore.getState().openDiff();

    const s = useDiffStore.getState();
    expect(s.baseMode).toBe("head");
    expect(s.attemptRepo).toBeNull();
    expect(s.baseBranch).toBeNull();
    expect(mergeBaseFn).not.toHaveBeenCalled();
  });
});

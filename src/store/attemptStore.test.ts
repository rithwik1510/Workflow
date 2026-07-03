// attemptStore — record lifecycle + boot reconcile against git's worktree list.
// git is mocked at the @/lib/gitClient boundary; plugin-store is stubbed so no
// real user config is touched.

import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@tauri-apps/plugin-store", () => ({
  load: vi.fn(async () => ({
    get: vi.fn(async () => null),
    set: vi.fn(async () => undefined),
    delete: vi.fn(async () => undefined),
    save: vi.fn(async () => undefined),
  })),
}));

const { worktreeList } = vi.hoisted(() => ({ worktreeList: vi.fn() }));
vi.mock("@/lib/gitClient", () => ({ gitWorktreeList: worktreeList }));

import { useAttemptStore, reconcileAttempts, type Attempt } from "@/store/attemptStore";
import { useToastStore } from "@/store/toastStore";

const mk = (over: Partial<Attempt> = {}): Attempt => ({
  repoRoot: "C:\\repos\\myrepo",
  repoName: "myrepo",
  baseBranch: "main",
  branch: "lume/fix",
  worktreePath: "C:\\Users\\posan\\lume\\worktrees\\myrepo\\fix",
  createdAt: 1,
  hintDismissed: false,
  ...over,
});

beforeEach(() => {
  useAttemptStore.getState().reset();
  useToastStore.getState().reset();
  worktreeList.mockReset();
});

describe("attemptStore actions", () => {
  it("adds, dismisses the hint, and removes", () => {
    const s = useAttemptStore.getState();
    s.addAttempt("sess-1", mk());
    expect(useAttemptStore.getState().attempts["sess-1"]).toBeDefined();
    expect(useAttemptStore.getState().attempts["sess-1"].hintDismissed).toBe(false);

    s.dismissHint("sess-1");
    expect(useAttemptStore.getState().attempts["sess-1"].hintDismissed).toBe(true);

    s.removeAttempt("sess-1");
    expect(useAttemptStore.getState().attempts["sess-1"]).toBeUndefined();
  });

  it("dismissHint on an unknown session is a no-op", () => {
    expect(() => useAttemptStore.getState().dismissHint("nope")).not.toThrow();
  });
});

describe("reconcileAttempts", () => {
  it("drops a record whose worktree is gone and toasts once", async () => {
    useAttemptStore.getState().addAttempt("sess-1", mk({ branch: "lume/gone" }));
    // git only knows the main checkout — the attempt folder vanished.
    worktreeList.mockResolvedValue([{ path: "C:/repos/myrepo", branch: "main" }]);

    await reconcileAttempts();

    expect(useAttemptStore.getState().attempts["sess-1"]).toBeUndefined();
    const toasts = useToastStore.getState().toasts;
    expect(toasts).toHaveLength(1);
    expect(toasts[0].severity).toBe("warn");
    expect(toasts[0].message).toContain("lume/gone");
  });

  it("keeps a record git still reports (path match across slash styles)", async () => {
    useAttemptStore.getState().addAttempt("sess-1", mk());
    // git emits forward slashes; the stored path uses backslashes — must match.
    worktreeList.mockResolvedValue([
      { path: "C:/repos/myrepo", branch: "main" },
      { path: "C:/Users/posan/lume/worktrees/myrepo/fix", branch: "lume/fix" },
    ]);

    await reconcileAttempts();

    expect(useAttemptStore.getState().attempts["sess-1"]).toBeDefined();
    expect(useToastStore.getState().toasts).toHaveLength(0);
  });

  it("keeps everything when git returns an empty list (ambiguous — repo gone)", async () => {
    useAttemptStore.getState().addAttempt("sess-1", mk());
    worktreeList.mockResolvedValue([]);

    await reconcileAttempts();

    expect(useAttemptStore.getState().attempts["sess-1"]).toBeDefined();
    expect(useToastStore.getState().toasts).toHaveLength(0);
  });

  it("degrades silently when git throws (never crashes boot)", async () => {
    useAttemptStore.getState().addAttempt("sess-1", mk());
    worktreeList.mockRejectedValue(new Error("git missing"));

    await expect(reconcileAttempts()).resolves.toBeUndefined();
    expect(useAttemptStore.getState().attempts["sess-1"]).toBeDefined();
  });

  it("hits git once per distinct repo", async () => {
    useAttemptStore.getState().addAttempt("a", mk({ repoRoot: "C:\\r1", worktreePath: "C:\\wt\\a" }));
    useAttemptStore.getState().addAttempt("b", mk({ repoRoot: "C:\\r1", worktreePath: "C:\\wt\\b" }));
    useAttemptStore.getState().addAttempt("c", mk({ repoRoot: "C:\\r2", worktreePath: "C:\\wt\\c" }));
    worktreeList.mockResolvedValue([{ path: "C:/wt/a", branch: "x" }, { path: "C:/wt/b", branch: "y" }, { path: "C:/wt/c", branch: "z" }]);

    await reconcileAttempts();

    expect(worktreeList).toHaveBeenCalledTimes(2); // r1 + r2
  });
});

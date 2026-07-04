// openBranch — the branch-switcher's decision matrix. NEVER an in-place
// checkout: jump to the worktree that has the branch (creating the session if
// missing), else create a worktree for it (existing local vs remote-tracking).

import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@tauri-apps/plugin-store", () => ({
  load: vi.fn(async () => ({
    get: vi.fn(async () => null),
    set: vi.fn(async () => undefined),
    delete: vi.fn(async () => undefined),
  })),
}));
const g = vi.hoisted(() => ({
  worktreeList: vi.fn(async (): Promise<{ path: string; branch: string | null }[]> => []),
  addExisting: vi.fn(async () => undefined),
  add: vi.fn(async () => undefined),
}));
vi.mock("@/lib/gitClient", () => ({
  gitWorktreeList: g.worktreeList,
  gitWorktreeAddExisting: g.addExisting,
  gitWorktreeAdd: g.add,
}));
vi.mock("@/lib/fsClient", () => ({ homeDir: vi.fn(async () => "C:\\Users\\t") }));

import { openBranch, localBranchName } from "@/sessions/openBranch";
import { useSessionsStore } from "@/store/sessionsStore";
import { useToastStore } from "@/store/toastStore";

const REPO = "C:/proj/app";

beforeEach(() => {
  useSessionsStore.getState().reset();
  useToastStore.getState().reset();
  g.worktreeList.mockReset().mockResolvedValue([]);
  g.addExisting.mockReset().mockResolvedValue(undefined);
  g.add.mockReset().mockResolvedValue(undefined);
});

describe("localBranchName", () => {
  it("locals pass through; remotes drop the remote segment only", () => {
    expect(localBranchName({ name: "main", isRemote: false })).toBe("main");
    expect(localBranchName({ name: "origin/main", isRemote: true })).toBe("main");
    // A branch that itself contains slashes keeps them.
    expect(localBranchName({ name: "origin/feature/x", isRemote: true })).toBe("feature/x");
  });
});

describe("openBranch", () => {
  it("jumps to the existing session when a worktree already has the branch", async () => {
    const s = useSessionsStore.getState();
    const existing = s.createSession("C:\\wt\\feat", "feat");
    g.worktreeList.mockResolvedValue([{ path: "C:\\wt\\feat", branch: "feat" }]);

    await openBranch(REPO, "app", { name: "feat", isRemote: false });

    expect(useSessionsStore.getState().activeSessionId).toBe(existing);
    expect(g.addExisting).not.toHaveBeenCalled();
    expect(g.add).not.toHaveBeenCalled();
  });

  it("creates a session for a worktree that exists on disk but has none", async () => {
    g.worktreeList.mockResolvedValue([{ path: "C:\\wt\\feat", branch: "feat" }]);

    await openBranch(REPO, "app", { name: "feat", isRemote: false });

    const st = useSessionsStore.getState();
    const active = st.activeSessionId ? st.sessions[st.activeSessionId] : null;
    expect(active?.folderPath).toBe("C:\\wt\\feat");
    expect(st.groupLabels["C:\\wt\\feat"]).toBe("app");
  });

  it("checks out an existing local branch into a fresh worktree under the home", async () => {
    await openBranch(REPO, "app", { name: "feature/x", isRemote: false });

    expect(g.addExisting).toHaveBeenCalledWith(
      REPO,
      "C:\\Users\\t\\lume\\worktrees\\app\\feature-x",
      "feature/x"
    );
    const st = useSessionsStore.getState();
    const active = st.activeSessionId ? st.sessions[st.activeSessionId] : null;
    expect(active?.folderPath).toBe("C:\\Users\\t\\lume\\worktrees\\app\\feature-x");
  });

  it("creates a tracking local for a remote-only branch", async () => {
    await openBranch(REPO, "app", { name: "origin/feat", isRemote: true });

    expect(g.add).toHaveBeenCalledWith(
      REPO,
      "C:\\Users\\t\\lume\\worktrees\\app\\feat",
      "feat",
      "origin/feat"
    );
  });

  it("surfaces a git failure as a toast and creates nothing", async () => {
    g.addExisting.mockRejectedValue({ kind: "internal", reason: "is already used by worktree" });

    await openBranch(REPO, "app", { name: "feat", isRemote: false });

    const toasts = useToastStore.getState().toasts;
    expect(toasts.length).toBe(1);
    expect(toasts[0].message).toContain("already used");
    expect(useSessionsStore.getState().activeSessionId).toBeNull();
  });
});

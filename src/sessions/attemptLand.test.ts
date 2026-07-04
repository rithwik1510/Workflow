// attemptLand — the pure Land decision core + GitHub URL helpers + the cleanup
// orchestration's stop-on-failure chain. git/gh are mocked at the @/lib/gitClient
// boundary; the confirm/toast/sessions stores are real (they touch no I/O).

import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@tauri-apps/plugin-store", () => ({
  load: vi.fn(async () => ({
    get: vi.fn(async () => null),
    set: vi.fn(async () => undefined),
    delete: vi.fn(async () => undefined),
    save: vi.fn(async () => undefined),
  })),
}));

const g = vi.hoisted(() => ({
  worktreeRemove: vi.fn(),
  branchDelete: vi.fn(),
  mergeAttempt: vi.fn(),
  prCreate: vi.fn(),
}));
vi.mock("@/lib/gitClient", () => ({
  gitWorktreeRemove: g.worktreeRemove,
  gitBranchDelete: g.branchDelete,
  gitMergeAttempt: g.mergeAttempt,
  ghPrCreate: g.prCreate,
}));

const openExternal = vi.hoisted(() => vi.fn());
vi.mock("@/lib/openExternal", () => ({ openExternal }));

import {
  decideLandPaths,
  isGitHubRemote,
  githubCompareUrl,
  landErrorText,
  cleanupAttempt,
  mergeAttemptLocally,
  createPrForAttempt,
} from "@/sessions/attemptLand";
import { useAttemptStore, type Attempt } from "@/store/attemptStore";
import { useConfirmStore } from "@/store/confirmStore";
import { useSessionsStore } from "@/store/sessionsStore";
import { useToastStore } from "@/store/toastStore";
import type { RepoState } from "@/lib/gitClient";

const attempt: Attempt = {
  repoRoot: "C:\\repos\\app",
  repoName: "app",
  baseBranch: "main",
  branch: "lume/fix",
  worktreePath: "C:\\Users\\p\\lume\\worktrees\\app\\fix",
  createdAt: 1,
  hintDismissed: false,
};

const clean = (branch: string | null): RepoState => ({ currentBranch: branch, clean: true });
const dirty = (branch: string | null): RepoState => ({ currentBranch: branch, clean: false });

beforeEach(() => {
  useAttemptStore.getState().reset();
  useToastStore.getState().reset();
  useSessionsStore.setState(useSessionsStore.getInitialState(), true);
  Object.values(g).forEach((m) => m.mockReset());
  openExternal.mockReset();
});

describe("decideLandPaths — the exhaustive matrix", () => {
  it("PR + local merge when remote, gh, on base, clean", () => {
    const d = decideLandPaths({
      hasRemote: true,
      isGitHubRemote: true,
      ghAvailable: true,
      repoState: clean("main"),
      baseBranch: "main",
    });
    expect(d.createPr.show).toBe(true);
    expect(d.openCompare.show).toBe(false); // gh present → no compare fallback
    expect(d.localMerge).toEqual({ show: true, enabled: true, reason: null });
  });

  it("compare page (not PR) when GitHub remote but gh absent", () => {
    const d = decideLandPaths({
      hasRemote: true,
      isGitHubRemote: true,
      ghAvailable: false,
      repoState: clean("main"),
      baseBranch: "main",
    });
    expect(d.createPr.show).toBe(false);
    expect(d.openCompare.show).toBe(true);
  });

  it("no PR and no compare when there's no remote (paths hidden, not dead)", () => {
    const d = decideLandPaths({
      hasRemote: false,
      isGitHubRemote: false,
      ghAvailable: true,
      repoState: clean("main"),
      baseBranch: "main",
    });
    expect(d.createPr.show).toBe(false);
    expect(d.openCompare.show).toBe(false);
    // Local merge is still shown (attempt sessions always offer it).
    expect(d.localMerge.show).toBe(true);
  });

  it("no compare for a non-GitHub remote without gh (only PR path is gone)", () => {
    const d = decideLandPaths({
      hasRemote: true,
      isGitHubRemote: false,
      ghAvailable: false,
      repoState: clean("main"),
      baseBranch: "main",
    });
    expect(d.createPr.show).toBe(false);
    expect(d.openCompare.show).toBe(false);
  });

  it("local merge disabled — wrong branch — names both branches", () => {
    const d = decideLandPaths({
      hasRemote: false,
      isGitHubRemote: false,
      ghAvailable: false,
      repoState: clean("feat/x"),
      baseBranch: "main",
    });
    expect(d.localMerge.enabled).toBe(false);
    expect(d.localMerge.reason).toContain("feat/x");
    expect(d.localMerge.reason).toContain("main");
  });

  it("local merge disabled — detached HEAD", () => {
    const d = decideLandPaths({
      hasRemote: false,
      isGitHubRemote: false,
      ghAvailable: false,
      repoState: clean(null),
      baseBranch: "main",
    });
    expect(d.localMerge.enabled).toBe(false);
    expect(d.localMerge.reason).toContain("detached");
  });

  it("local merge disabled — on base but dirty", () => {
    const d = decideLandPaths({
      hasRemote: false,
      isGitHubRemote: false,
      ghAvailable: false,
      repoState: dirty("main"),
      baseBranch: "main",
    });
    expect(d.localMerge.enabled).toBe(false);
    expect(d.localMerge.reason).toContain("uncommitted");
  });

  it("wrong-branch reason wins over dirtiness when both are true", () => {
    const d = decideLandPaths({
      hasRemote: false,
      isGitHubRemote: false,
      ghAvailable: false,
      repoState: dirty("feat/x"),
      baseBranch: "main",
    });
    expect(d.localMerge.reason).toContain("feat/x"); // branch mismatch reported first
  });
});

describe("GitHub remote helpers", () => {
  it("recognises https and ssh GitHub remotes; rejects others", () => {
    expect(isGitHubRemote("https://github.com/o/r.git")).toBe(true);
    expect(isGitHubRemote("git@github.com:o/r.git")).toBe(true);
    expect(isGitHubRemote("https://gitlab.com/o/r.git")).toBe(false);
    expect(isGitHubRemote(null)).toBe(false);
  });

  it("builds a compare URL from https and ssh remotes, stripping .git", () => {
    // The `lume/fix` slash stays a literal slash (GitHub compare URLs accept it);
    // per-segment encoding only escapes truly special characters.
    expect(githubCompareUrl("https://github.com/o/r.git", "main", "lume/fix")).toBe(
      "https://github.com/o/r/compare/main...lume/fix"
    );
    expect(githubCompareUrl("git@github.com:o/r.git", "main", "lume/fix")).toBe(
      "https://github.com/o/r/compare/main...lume/fix"
    );
  });

  it("encodes special characters in a branch segment", () => {
    expect(githubCompareUrl("https://github.com/o/r.git", "main", "fix#1")).toBe(
      "https://github.com/o/r/compare/main...fix%231"
    );
  });

  it("returns null for a non-GitHub remote", () => {
    expect(githubCompareUrl("https://gitlab.com/o/r.git", "main", "x")).toBeNull();
  });

  it("landErrorText pulls AppError.reason verbatim", () => {
    expect(landErrorText({ kind: "internal", reason: "branch not merged" })).toBe(
      "branch not merged"
    );
    expect(landErrorText(new Error("boom"))).toBe("boom");
  });
});

describe("mergeAttemptLocally", () => {
  it("surfaces git's refusal verbatim and does NOT offer cleanup", async () => {
    g.mergeAttempt.mockRejectedValue({ kind: "internal", reason: "main checkout is dirty" });
    const confirmSpy = vi.spyOn(useConfirmStore.getState(), "confirm");

    await mergeAttemptLocally("sess", attempt);

    const toasts = useToastStore.getState().toasts;
    expect(toasts.some((t) => t.severity === "error" && t.message === "main checkout is dirty")).toBe(
      true
    );
    expect(confirmSpy).not.toHaveBeenCalled(); // no cleanup offer on a failed merge
  });

  it("on success toasts then offers cleanup (confirm)", async () => {
    g.mergeAttempt.mockResolvedValue(undefined);
    // Decline the cleanup confirm so the chain stops cleanly.
    vi.spyOn(useConfirmStore.getState(), "confirm").mockResolvedValue(false);

    await mergeAttemptLocally("sess", attempt);

    const toasts = useToastStore.getState().toasts;
    expect(toasts.some((t) => t.severity === "success")).toBe(true);
    expect(useConfirmStore.getState().confirm).toHaveBeenCalled();
  });
});

describe("createPrForAttempt", () => {
  it("toasts the PR URL and opens it; never touches cleanup", async () => {
    g.prCreate.mockResolvedValue("https://github.com/o/r/pull/7");
    await createPrForAttempt(attempt);
    expect(openExternal).toHaveBeenCalledWith("https://github.com/o/r/pull/7");
    const toasts = useToastStore.getState().toasts;
    expect(toasts.some((t) => t.message.includes("pull/7"))).toBe(true);
  });

  it("surfaces gh's stderr verbatim on failure", async () => {
    g.prCreate.mockRejectedValue({ kind: "internal", reason: "gh: not authenticated" });
    await createPrForAttempt(attempt);
    const toasts = useToastStore.getState().toasts;
    expect(toasts.some((t) => t.severity === "error" && t.message === "gh: not authenticated")).toBe(
      true
    );
    expect(openExternal).not.toHaveBeenCalled();
  });
});

describe("cleanupAttempt — confirm-gated, stop-on-failure chain", () => {
  beforeEach(() => {
    useAttemptStore.getState().addAttempt("sess", attempt);
    useSessionsStore.getState().createSession(attempt.worktreePath, "fix");
  });

  it("does nothing when the user declines the confirm", async () => {
    vi.spyOn(useConfirmStore.getState(), "confirm").mockResolvedValue(false);
    await cleanupAttempt("sess", attempt);
    expect(g.worktreeRemove).not.toHaveBeenCalled();
    expect(g.branchDelete).not.toHaveBeenCalled();
  });

  it("removes worktree → deletes branch → marks landed on the happy path", async () => {
    vi.spyOn(useConfirmStore.getState(), "confirm").mockResolvedValue(true);
    g.worktreeRemove.mockResolvedValue(undefined);
    g.branchDelete.mockResolvedValue(undefined);

    await cleanupAttempt("sess", attempt);

    expect(g.worktreeRemove).toHaveBeenCalledWith(attempt.repoRoot, attempt.worktreePath);
    expect(g.branchDelete).toHaveBeenCalledWith(attempt.repoRoot, attempt.branch);
    expect(useAttemptStore.getState().attempts["sess"].landedAt).toBeTypeOf("number");
    expect(useToastStore.getState().toasts.some((t) => t.severity === "success")).toBe(true);
  });

  it("STOPS at a dirty-worktree refusal — never deletes the branch", async () => {
    vi.spyOn(useConfirmStore.getState(), "confirm").mockResolvedValue(true);
    g.worktreeRemove.mockRejectedValue({ kind: "internal", reason: "worktree is dirty" });

    await cleanupAttempt("sess", attempt);

    expect(g.branchDelete).not.toHaveBeenCalled(); // chain halted
    expect(useAttemptStore.getState().attempts["sess"].landedAt).toBeUndefined();
    expect(
      useToastStore.getState().toasts.some((t) => t.severity === "error" && t.message === "worktree is dirty")
    ).toBe(true);
  });

  it("STOPS at an unmerged-branch refusal (worktree already gone) and surfaces it", async () => {
    vi.spyOn(useConfirmStore.getState(), "confirm").mockResolvedValue(true);
    g.worktreeRemove.mockResolvedValue(undefined);
    g.branchDelete.mockRejectedValue({ kind: "internal", reason: "branch not fully merged" });

    await cleanupAttempt("sess", attempt);

    expect(useAttemptStore.getState().attempts["sess"].landedAt).toBeUndefined();
    expect(
      useToastStore.getState().toasts.some(
        (t) => t.severity === "error" && t.message === "branch not fully merged"
      )
    ).toBe(true);
  });
});

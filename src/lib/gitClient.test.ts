// isAgentInternalBranch — the switcher/fork-base filter that hides Claude Code's
// auto-generated `worktree-agent-<hex>` scratch branches while keeping every
// human-meaningful branch (including real work that lives under .claude/worktrees).

import { describe, it, expect } from "vitest";

import { isAgentInternalBranch } from "@/lib/gitClient";

describe("isAgentInternalBranch", () => {
  it("hides agent scratch branches, local and remote", () => {
    expect(isAgentInternalBranch("worktree-agent-a01a2dccf3a81778a")).toBe(true);
    expect(isAgentInternalBranch("worktree-agent-ae90934598116867c")).toBe(true);
    expect(isAgentInternalBranch("origin/worktree-agent-a5b554edff1026bb4")).toBe(true);
  });

  it("keeps every human branch, including feat/* under .claude/worktrees", () => {
    for (const name of [
      "main",
      "origin/main",
      "feat/beta-trilogy",
      "feat/plan-010-editor-phase-a",
      "advisor/006-restore-stampede-and-poller-pileup",
      "release/v0.1.0-beta.1",
      "backup/main-pre-rebase-2026-07-02",
      "lume/worflow-attempt-1",
    ]) {
      expect(isAgentInternalBranch(name)).toBe(false);
    }
  });

  it("does not match a branch that merely mentions the prefix as a substring", () => {
    // Not anchored to a path segment → a real branch someone deliberately named.
    expect(isAgentInternalBranch("fix-worktree-agent-spawn")).toBe(false);
    // Non-hex suffix is a human name, not a generated id.
    expect(isAgentInternalBranch("worktree-agent-notes")).toBe(false);
  });
});

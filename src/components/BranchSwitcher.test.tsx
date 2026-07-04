// BranchSwitcher — chip render + picker open + selection routing. The heavy
// logic (worktree jump/create matrix) lives in openBranch.test.ts; here we
// prove the chip only exists when the active session knows its branch, the
// picker lists what git returns, and selecting routes through openBranch.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

vi.mock("@tauri-apps/plugin-store", () => ({
  load: vi.fn(async () => ({
    get: vi.fn(async () => null),
    set: vi.fn(async () => undefined),
    delete: vi.fn(async () => undefined),
  })),
}));
const g = vi.hoisted(() => ({
  repoRoot: vi.fn(async (): Promise<string | null> => "C:/proj/app"),
  listBranches: vi.fn(
    async (): Promise<{ name: string; isCurrent: boolean; isRemote: boolean }[]> => [
      { name: "main", isCurrent: true, isRemote: false },
      { name: "feat", isCurrent: false, isRemote: false },
      { name: "origin/remote-only", isCurrent: false, isRemote: true },
    ]
  ),
  worktreeList: vi.fn(async (): Promise<{ path: string; branch: string | null }[]> => [
    { path: "C:/proj/app", branch: "main" },
  ]),
}));
vi.mock("@/lib/gitClient", () => ({
  gitRepoRoot: g.repoRoot,
  gitListBranches: g.listBranches,
  gitWorktreeList: g.worktreeList,
}));
const openBranchMock = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("@/sessions/openBranch", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/sessions/openBranch")>();
  return { ...actual, openBranch: openBranchMock };
});

import { BranchSwitcher } from "@/components/BranchSwitcher";
import { useSessionsStore } from "@/store/sessionsStore";

function activeSessionOnBranch(branch: string | null): void {
  const s = useSessionsStore.getState();
  const id = s.createSession("C:/proj/app", "app");
  s.activateSession(id);
  if (branch) {
    useSessionsStore.setState((st) => ({
      sessions: {
        ...st.sessions,
        [id]: { ...st.sessions[id], gitBranch: branch },
      },
    }));
  }
}

beforeEach(() => {
  useSessionsStore.getState().reset();
  openBranchMock.mockClear();
});

describe("BranchSwitcher", () => {
  it("renders nothing when the active session has no known branch", () => {
    activeSessionOnBranch(null);
    const { container } = render(<BranchSwitcher />);
    expect(container.firstChild).toBeNull();
  });

  it("shows the chip and opens the picker with git's branches", async () => {
    activeSessionOnBranch("main");
    render(<BranchSwitcher />);
    const chip = screen.getByRole("button", { name: /⎇ main/ });
    fireEvent.click(chip);
    await waitFor(() => expect(screen.getByText("feat")).toBeTruthy());
    expect(screen.getByText("current")).toBeTruthy(); // main marked
    expect(screen.getByText("origin/remote-only")).toBeTruthy();
    // main has a worktree already but is current — "open" tags only non-current.
  });

  it("selecting a branch routes through openBranch and closes", async () => {
    activeSessionOnBranch("main");
    render(<BranchSwitcher />);
    fireEvent.click(screen.getByRole("button", { name: /⎇ main/ }));
    await waitFor(() => expect(screen.getByText("feat")).toBeTruthy());
    fireEvent.click(screen.getByText("feat"));
    expect(openBranchMock).toHaveBeenCalledWith("C:/proj/app", "app", {
      name: "feat",
      isRemote: false,
    });
  });

  it("selecting the current branch is a no-op (no openBranch call)", async () => {
    activeSessionOnBranch("main");
    render(<BranchSwitcher />);
    fireEvent.click(screen.getByRole("button", { name: /⎇ main/ }));
    await waitFor(() => expect(screen.getByText("current")).toBeTruthy());
    fireEvent.click(screen.getByText("main"));
    expect(openBranchMock).not.toHaveBeenCalled();
  });
});

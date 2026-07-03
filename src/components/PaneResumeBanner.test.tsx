import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

// No Tauri runtime in tests: stub plugin-store (persist), the pty write, and the
// fs existence check. NO real user config / directory is ever touched.
vi.mock("@tauri-apps/plugin-store", () => ({
  load: vi.fn(async () => ({
    get: vi.fn(async () => null),
    set: vi.fn(async () => undefined),
    delete: vi.fn(async () => undefined),
  })),
}));
const writePty = vi.fn(async () => undefined);
vi.mock("@/terminals/ptyClient", () => ({ writePty: (...a: unknown[]) => writePty(...(a as [])) }));
let dirExistsValue = true;
vi.mock("@/lib/fsClient", () => ({ dirExists: vi.fn(async () => dirExistsValue) }));

import { PaneResumeBanner } from "@/components/PaneResumeBanner";
import { usePaneResumeStore } from "@/store/paneResumeStore";
import { useAgentStore } from "@/store/agentStore";

beforeEach(() => {
  writePty.mockClear();
  dirExistsValue = true;
  usePaneResumeStore.getState().reset();
  useAgentStore.getState().reset();
});

function seed(paneId: string, over = {}) {
  usePaneResumeStore.getState().recordAgentStart(paneId, { agentSessionId: "sess-1", cwd: "/proj" });
  if (Object.keys(over).length) {
    usePaneResumeStore.setState((s) => ({
      records: { ...s.records, [paneId]: { ...s.records[paneId], ...over } },
    }));
  }
}

describe("PaneResumeBanner — render states", () => {
  it("renders nothing when there is no resume record", () => {
    const { container } = render(<PaneResumeBanner paneId="p1" />);
    expect(container.firstChild).toBeNull();
  });

  it("shows the agent, the label and both actions for an alive record", async () => {
    seed("p1");
    render(<PaneResumeBanner paneId="p1" />);
    expect(await screen.findByText(/Claude was running here/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Resume" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Just shell" })).toBeTruthy();
  });

  it("is hidden once a live agent registers for the pane (resume took)", () => {
    seed("p1");
    useAgentStore.getState().setPaneAgent("p1", { agent: "claude", phase: "idle", source: "hook" });
    const { container } = render(<PaneResumeBanner paneId="p1" />);
    expect(container.firstChild).toBeNull();
  });

  it("stays hidden for an ended (not-alive) record", () => {
    seed("p1", { aliveAtShutdown: false });
    const { container } = render(<PaneResumeBanner paneId="p1" />);
    expect(container.firstChild).toBeNull();
  });

  it("Resume writes the exact resume command + CR, KEEPS the record, and registers identity", async () => {
    seed("p1"); // claude + sess-1 → "claude --resume sess-1"
    render(<PaneResumeBanner paneId="p1" />);
    fireEvent.click(await screen.findByRole("button", { name: "Resume" }));
    expect(writePty).toHaveBeenCalledWith("p1", "claude --resume sess-1\r");
    // The record survives (clearing it made hook-less agents resumable exactly
    // once) and keeps the session id for the NEXT restart's exact resume.
    const rec = usePaneResumeStore.getState().records["p1"];
    expect(rec).toBeDefined();
    expect(rec!.agentSessionId).toBe("sess-1");
    expect(rec!.aliveAtShutdown).toBe(true);
    // notePaneLaunch registered command-derived identity — this is what hides
    // the banner (hasLiveAgent), not record deletion.
    expect(useAgentStore.getState().panes["p1"]?.agent).toBe("claude");
  });

  it("Codex survives a Resume round-trip — the record still offers resume next restart", async () => {
    // The regression this guards: hook-less agents have nothing to re-create a
    // cleared record, so Resume used to work exactly once for Codex.
    usePaneResumeStore
      .getState()
      .recordLaunchCommand("p2", { agent: "codex", launchCommand: "codex", cwd: "/proj" });
    render(<PaneResumeBanner paneId="p2" />);
    fireEvent.click(await screen.findByRole("button", { name: "Resume" }));
    expect(writePty).toHaveBeenCalledWith("p2", "codex resume --last\r");
    const rec = usePaneResumeStore.getState().records["p2"];
    expect(rec).toBeDefined();
    expect(rec!.agent).toBe("codex");
    expect(rec!.aliveAtShutdown).toBe(true);
  });

  it("Just shell clears the record without writing to the pty", async () => {
    seed("p1");
    render(<PaneResumeBanner paneId="p1" />);
    fireEvent.click(await screen.findByRole("button", { name: "Just shell" }));
    expect(writePty).not.toHaveBeenCalled();
    expect(usePaneResumeStore.getState().records["p1"]).toBeUndefined();
  });

  it("warns and disables Resume when the recorded folder no longer exists", async () => {
    dirExistsValue = false;
    seed("p1");
    render(<PaneResumeBanner paneId="p1" />);
    expect(await screen.findByText(/folder missing/i)).toBeTruthy();
    const resume = screen.getByRole("button", { name: "Resume" }) as HTMLButtonElement;
    expect(resume.disabled).toBe(true);
    fireEvent.click(resume);
    expect(writePty).not.toHaveBeenCalled();
  });
});

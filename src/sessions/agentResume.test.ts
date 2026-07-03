import { describe, it, expect } from "vitest";

import { resumeCommandFor, isAutoResumable, shouldAutoResume } from "@/sessions/agentResume";
import type { ResumeRecord } from "@/store/paneResumeStore";

function rec(over: Partial<ResumeRecord>): ResumeRecord {
  return {
    agent: "claude",
    launchCommand: "claude",
    cwd: "/w",
    aliveAtShutdown: true,
    lastSeenAt: 0,
    ...over,
  };
}

describe("agentResume — resumeCommandFor adapter table", () => {
  it("claude with a session id → --resume <id>", () => {
    expect(resumeCommandFor(rec({ agent: "claude", agentSessionId: "abc123" }))).toBe(
      "claude --resume abc123"
    );
  });

  it("claude without a session id → --continue", () => {
    expect(resumeCommandFor(rec({ agent: "claude", agentSessionId: undefined }))).toBe(
      "claude --continue"
    );
  });

  it("codex with a session id → codex resume <id>", () => {
    expect(resumeCommandFor(rec({ agent: "codex", agentSessionId: "xyz" }))).toBe(
      "codex resume xyz"
    );
  });

  it("codex without a session id → codex resume --last", () => {
    expect(resumeCommandFor(rec({ agent: "codex", agentSessionId: undefined }))).toBe(
      "codex resume --last"
    );
  });

  it("gemini falls through to the original launch command verbatim (safe floor)", () => {
    expect(
      resumeCommandFor(rec({ agent: "gemini", launchCommand: "npx @google/gemini-cli --yolo" }))
    ).toBe("npx @google/gemini-cli --yolo");
  });

  it("original launch flags are NEVER merged into the resume command", () => {
    // A claude launched with --model opus still resumes as a bare --resume <id>.
    expect(
      resumeCommandFor(rec({ agent: "claude", agentSessionId: "id", launchCommand: "claude --model opus" }))
    ).toBe("claude --resume id");
  });

  it("blank session id is treated as no id", () => {
    expect(resumeCommandFor(rec({ agent: "claude", agentSessionId: "   " }))).toBe(
      "claude --continue"
    );
  });
});

describe("agentResume — isAutoResumable", () => {
  it("claude and codex are auto-resumable; gemini is not", () => {
    expect(isAutoResumable("claude")).toBe(true);
    expect(isAutoResumable("codex")).toBe(true);
    expect(isAutoResumable("gemini")).toBe(false);
  });
});

describe("agentResume — shouldAutoResume gating matrix", () => {
  const on = { autoResumeOn: true, cwdExists: true };

  it("all four conditions pass → true (claude and codex)", () => {
    expect(shouldAutoResume(rec({ agent: "claude" }), on)).toBe(true);
    expect(shouldAutoResume(rec({ agent: "codex" }), on)).toBe(true);
  });

  it("no record → false", () => {
    expect(shouldAutoResume(undefined, on)).toBe(false);
  });

  it("not alive at shutdown → false", () => {
    expect(shouldAutoResume(rec({ aliveAtShutdown: false }), on)).toBe(false);
  });

  it("setting off → false", () => {
    expect(shouldAutoResume(rec({}), { autoResumeOn: false, cwdExists: true })).toBe(false);
  });

  it("gemini (not resumable) → false even with everything else on", () => {
    expect(shouldAutoResume(rec({ agent: "gemini" }), on)).toBe(false);
  });

  it("cwd missing → false (banner shows folder-missing hint instead)", () => {
    expect(shouldAutoResume(rec({}), { autoResumeOn: true, cwdExists: false })).toBe(false);
  });
});

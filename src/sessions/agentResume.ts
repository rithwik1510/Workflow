// agentResume — the resume-command adapter table (Plan 009).
//
// Given a persisted ResumeRecord, produce the EXACT command string that brings
// that agent back. This is the whole "never steering" boundary in one function:
// we only ever emit a launch/resume command the agent's own CLI documents — we
// never compose a prompt, never merge the original launch flags, never talk to
// a running agent. The banner shows this exact string before it runs; the pty
// write is byte-for-byte what `resumeCommandFor` returns plus a carriage return.
//
// Adapter rules:
//   claude + session id → `claude --resume <id>`   (exact conversation)
//   claude, no id       → `claude --continue`      (most-recent conversation)
//   codex  + session id → `codex resume <id>`
//   codex, no id        → `codex resume --last`
//   gemini / anything else → the ORIGINAL launch command, verbatim (safe floor)
//
// The safe floor is why gemini/unknown are NEVER auto-resumed: re-running a raw
// launch command unprompted could restart work the user didn't ask to restart.
// Only claude/codex — which have real resume verbs — auto-resume.

import type { AgentName } from "@/store/agentStore";
import type { ResumeRecord } from "@/store/paneResumeStore";

/** The full auto-resume gate as one pure predicate (Plan 009), so the matrix —
 *  aliveAtShutdown × setting on/off × agent kind × cwd-exists — is unit-testable
 *  without driving the orchestrator. All four must pass to auto-write a resume:
 *    - the record must exist and have been alive at shutdown,
 *    - the "auto-resume on restore" setting must be on,
 *    - the agent must have a real resume verb (claude/codex; never gemini),
 *    - the recorded cwd must still exist on disk. */
export function shouldAutoResume(
  record: Pick<ResumeRecord, "agent" | "aliveAtShutdown"> | undefined,
  opts: { autoResumeOn: boolean; cwdExists: boolean }
): boolean {
  if (!record || !record.aliveAtShutdown) return false;
  if (!opts.autoResumeOn) return false;
  if (!isAutoResumable(record.agent)) return false;
  return opts.cwdExists;
}

/** The command that resumes the agent recorded for a pane. Never null: gemini
 *  and any future/unknown agent fall through to the original launch command. */
export function resumeCommandFor(record: ResumeRecord): string {
  const id = record.agentSessionId?.trim();
  switch (record.agent) {
    case "claude":
      return id ? `claude --resume ${id}` : "claude --continue";
    case "codex":
      return id ? `codex resume ${id}` : "codex resume --last";
    default:
      // gemini / unknown — re-offer exactly what the user launched.
      return record.launchCommand;
  }
}

/** Agents that have a real resume verb and are therefore safe to auto-resume
 *  (write without the user clicking). Gemini/unknown are excluded — their floor
 *  is a raw re-launch, which we only ever do on an explicit click. */
export function isAutoResumable(agent: AgentName): boolean {
  return agent === "claude" || agent === "codex";
}

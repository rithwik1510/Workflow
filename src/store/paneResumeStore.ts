// paneResumeStore — durable "what agent was launched here" memory, so a pane
// that was running an agent when Lume closed can be RESUMED on the next launch
// (Plan 009). This is the ONE store in the app that persists agent-adjacent
// state: agentStore itself is deliberately transient (the PTY and the agent are
// both gone across a restart), but the *fact that an agent ran here* — plus the
// agent's own session id — is exactly what we need to offer "Resume" instead of
// a fresh shell.
//
// PRODUCT BOUNDARY (hard rule, Plan 009): a record only ever stores what the
// user launched (the verbatim launch command) and the agent's own resume id.
// It NEVER holds prompts, transcript contents, or anything that would let us
// talk to a running agent. Resume replays a launch command; it never composes.
//
// Keyed by paneId. There is a subtlety that would otherwise silently break
// restore: sessionsStore reassigns every persisted paneId to a fresh id on
// rehydrate (see remapSessionPaneIds — the counter resets each launch, so ids
// collide across runs). A record keyed by the OLD paneId would never match the
// NEW pane. `applyPaneIdRemap` bridges that: sessionsStore hands us the same
// old→new map it built, and we re-key our records to match. It tolerates either
// hydration order (this store vs sessionsStore) via a pending-map that is also
// consumed on our own rehydrate.

import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import { immer } from "zustand/middleware/immer";

import type { AgentName } from "@/store/agentStore";
import { tauriPersistStorage } from "@/lib/persistStorage";
import type { PaneId } from "@/types";

export interface ResumeRecord {
  /** Which agent ran in this pane (drives the glyph + the resume adapter). */
  agent: AgentName;
  /** The exact command the user launched (e.g. "claude", "npx @openai/codex").
   *  The safe floor for gemini/unknown resume: re-offer this verbatim. */
  launchCommand: string;
  /** The agent's OWN session id from its hooks (Claude) — enables
   *  `claude --resume <id>`. Undefined for command-only identity. */
  agentSessionId?: string;
  /** Working directory the agent ran in. Auto-resume is skipped (and the banner
   *  warns) when this no longer exists on disk. */
  cwd: string | null;
  /** True while the agent is/was running; flipped false on SessionEnd. Whatever
   *  it is at app-close is what persists — a pane still `true` at shutdown is
   *  the case this whole store exists for. */
  aliveAtShutdown: boolean;
  /** Epoch ms of the last event that touched this record (start / launch / end). */
  lastSeenAt: number;
}

interface PaneResumeState {
  records: Record<PaneId, ResumeRecord>;
  /** Persisted preference (Plan 009, default OFF): auto-write the resume command
   *  on restore. Lives here rather than settingsStore/config.toml because it's a
   *  behavioural preference, not a config.toml key — the same call the sessions
   *  store makes for `reopenLastSession`. */
  autoResumeOnRestore: boolean;
}

interface PaneResumeActions {
  /** Claude hook events: upsert identity + cwd (+ resume id), mark alive.
   *  Agent is always claude (these ARE Claude's hooks). Called WITHOUT
   *  `agentSessionId` on SessionStart and WITH it on the first content
   *  evidence (UserPromptSubmit / Stop / permission): Claude only writes a
   *  session's transcript once a message lands, so an empty session's id
   *  resumes nothing — it must never clobber the previous real conversation's
   *  id (see agentTracker). Keeps any launch command already captured. */
  recordAgentStart: (
    paneId: PaneId,
    fields: { agentSessionId?: string; cwd?: string | null }
  ) => void;
  /** Launch-command detection: record the agent + verbatim command, mark alive.
   *  A same-agent re-record keeps the known session id; a different agent
   *  replaces the record (the session id no longer applies). */
  recordLaunchCommand: (
    paneId: PaneId,
    fields: { agent: AgentName; launchCommand: string; cwd?: string | null }
  ) => void;
  /** SessionEnd: the agent stopped cleanly, so it should NOT re-offer a resume
   *  on next launch. Keeps the record (dashboard fuel) but clears the alive flag. */
  markEnded: (paneId: PaneId) => void;
  /** Drop the record entirely — user ran a different command, clicked
   *  "Just shell", or closed the pane themselves (never on app shutdown). */
  clearRecord: (paneId: PaneId) => void;
  setAutoResumeOnRestore: (on: boolean) => void;
  /** Re-key records old→new (paneId remap bridge). Idempotent. */
  remapKeys: (map: Record<string, string>) => void;
  reset: () => void;
}

export type PaneResumeStore = PaneResumeState & PaneResumeActions;

/** v1 → v2 heal (exported for tests): v1 recorded the session id from
 *  SessionStart, so ids of EMPTY sessions — which have no transcript on disk;
 *  `claude --resume <id>` says "No conversation found" — overwrote real ones.
 *  Every v1 id is untrustworthy wholesale: strip them. Resume then falls back
 *  to `claude --continue`, which finds the most recent REAL conversation in
 *  the pane's cwd. Fresh ids are only ever recorded on content evidence
 *  (UserPromptSubmit / Stop / permission — see agentTracker). */
export function migrateResumeStore(persisted: unknown, version: number): unknown {
  if (version >= 2 || !persisted || typeof persisted !== "object") return persisted;
  const p = persisted as {
    records?: Record<string, ResumeRecord>;
    autoResumeOnRestore?: boolean;
  };
  const records: Record<string, ResumeRecord> = {};
  for (const [paneId, rec] of Object.entries(p.records ?? {})) {
    records[paneId] = { ...rec, agentSessionId: undefined };
  }
  return { ...p, records };
}

function applyRemap(
  records: Record<PaneId, ResumeRecord>,
  map: Record<string, string>
): Record<PaneId, ResumeRecord> {
  if (Object.keys(map).length === 0) return records;
  const next: Record<PaneId, ResumeRecord> = {};
  for (const [id, rec] of Object.entries(records)) {
    // A fresh (already-remapped) id is never a key in `map` (new ids come from
    // nextPaneId, which never reuses an old id), so re-applying is a no-op.
    next[map[id] ?? id] = rec;
  }
  return next;
}

export const usePaneResumeStore = create<PaneResumeStore>()(
  persist(
    immer((set) => ({
      records: {},
      autoResumeOnRestore: false,

      recordAgentStart: (paneId, fields) =>
        set((s) => {
          const prev = s.records[paneId];
          s.records[paneId] = {
            agent: "claude",
            launchCommand: prev?.launchCommand ?? "claude",
            agentSessionId: fields.agentSessionId ?? prev?.agentSessionId,
            cwd: fields.cwd ?? prev?.cwd ?? null,
            aliveAtShutdown: true,
            lastSeenAt: Date.now(),
          };
        }),

      recordLaunchCommand: (paneId, fields) =>
        set((s) => {
          const prev = s.records[paneId];
          const sameAgent = prev?.agent === fields.agent;
          s.records[paneId] = {
            agent: fields.agent,
            launchCommand: fields.launchCommand,
            // Keep the resume id only when the agent is unchanged; a different
            // agent's id is meaningless.
            agentSessionId: sameAgent ? prev?.agentSessionId : undefined,
            cwd: fields.cwd ?? prev?.cwd ?? null,
            aliveAtShutdown: true,
            lastSeenAt: Date.now(),
          };
        }),

      markEnded: (paneId) =>
        set((s) => {
          const rec = s.records[paneId];
          if (!rec) return;
          rec.aliveAtShutdown = false;
          rec.lastSeenAt = Date.now();
        }),

      clearRecord: (paneId) =>
        set((s) => {
          delete s.records[paneId];
        }),

      setAutoResumeOnRestore: (on) =>
        set((s) => {
          s.autoResumeOnRestore = on;
        }),

      remapKeys: (map) =>
        set((s) => {
          s.records = applyRemap(s.records, map);
        }),

      reset: () =>
        set((s) => {
          s.records = {};
          s.autoResumeOnRestore = false;
        }),
    })),
    {
      name: "resume",
      storage: createJSONStorage(() => tauriPersistStorage("lume-resume.json")),
      version: 2,
      migrate: migrateResumeStore,
      partialize: (state) => ({
        records: state.records,
        autoResumeOnRestore: state.autoResumeOnRestore,
      }),
      onRehydrateStorage: () => (state) => {
        if (!state) return;
        // Consume any remap sessionsStore published before we finished loading
        // (see applyPaneIdRemap): our freshly-hydrated records still hold OLD
        // paneIds, so re-key them now.
        if (Object.keys(pendingRemap).length > 0) {
          usePaneResumeStore.setState((s) => ({
            records: applyRemap(s.records, pendingRemap),
          }));
        }
      },
    }
  )
);

// ---------------------------------------------------------------------------
// paneId remap bridge (see the module header). sessionsStore calls this with
// the old→new map it builds on rehydrate. We apply it to whatever records are
// already loaded AND remember it, so a record set that hydrates LATER (our
// onRehydrateStorage) still gets re-keyed. Handles either hydration order.
// ---------------------------------------------------------------------------
let pendingRemap: Record<string, string> = {};

export function applyPaneIdRemap(map: Record<string, string>): void {
  if (Object.keys(map).length === 0) return;
  pendingRemap = { ...pendingRemap, ...map };
  usePaneResumeStore.getState().remapKeys(pendingRemap);
}

/** Test-only: reset the module-level pending remap. */
export function _resetPaneResumeRemap(): void {
  pendingRemap = {};
}

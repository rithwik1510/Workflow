import { describe, it, expect, vi } from "vitest";

// attentionEscape imports the Tauri window API + attentionClient (which pulls
// in the notification plugin) + persisted stores (plugin-store). None are used
// by the PURE decideEscape under test, but importing the module loads them, so
// stub them out — no Tauri runtime, and NO real user config is ever touched.
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    isFocused: vi.fn(async () => true),
    listen: vi.fn(async () => vi.fn()),
  }),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => undefined) }));
vi.mock("@tauri-apps/plugin-notification", () => ({
  sendNotification: vi.fn(),
  isPermissionGranted: vi.fn(async () => true),
  requestPermission: vi.fn(async () => "granted"),
}));
vi.mock("@tauri-apps/plugin-store", () => ({
  load: vi.fn(async () => ({
    get: vi.fn(async () => null),
    set: vi.fn(async () => undefined),
    delete: vi.fn(async () => undefined),
  })),
}));

import { decideEscape, TOAST_MIN_GAP_MS, type EscapeInput } from "@/sessions/attentionEscape";
import { needsYouCounts } from "@/sessions/sessionSignal";
import { leaf } from "@/store/layout/tree";
import type { PaneAgent } from "@/store/agentStore";
import type { Session } from "@/store/sessionsStore";

// A permission-block edge, unfocused + hidden, master ON, no turn-toast, no
// prior toast. Individual cases override exactly the fields they exercise.
const base: EscapeInput = {
  transition: { paneId: "p1", from: "working", to: "permission" },
  agent: "claude",
  sessionName: "api-server",
  windowFocused: false,
  sessionVisible: false,
  prefs: { osNotifications: true, toastOnTurnComplete: false },
  now: 1_000_000,
  lastToastAt: 0,
};
const input = (over: Partial<EscapeInput>): EscapeInput => ({ ...base, ...over });

describe("decideEscape — the permission escape (toast + flash)", () => {
  it("fires toast + flash entering permission while unfocused", () => {
    const d = decideEscape(base);
    expect(d.flash).toBe(true);
    expect(d.toast).toEqual({ title: "⏸ Claude needs permission", body: "api-server" });
  });

  it("names the actual agent in the title", () => {
    expect(decideEscape(input({ agent: "codex" })).toast?.title).toBe(
      "⏸ Codex needs permission"
    );
  });

  it("escapes when unfocused even if the session is visible", () => {
    const d = decideEscape(input({ windowFocused: false, sessionVisible: true }));
    expect(d.toast).toBeDefined();
    expect(d.flash).toBe(true);
  });

  it("escapes when focused but the session is off-screen", () => {
    const d = decideEscape(input({ windowFocused: true, sessionVisible: false }));
    expect(d.toast).toBeDefined();
    expect(d.flash).toBe(true);
  });
});

describe("decideEscape — suppression", () => {
  it("suppresses everything when focused AND the session is visible", () => {
    expect(decideEscape(input({ windowFocused: true, sessionVisible: true }))).toEqual({
      flash: false,
    });
  });

  it("suppresses everything when the master toggle is OFF", () => {
    const d = decideEscape(input({ prefs: { osNotifications: false, toastOnTurnComplete: true } }));
    expect(d).toEqual({ flash: false });
  });
});

describe("decideEscape — edge-triggering", () => {
  it("does NOT fire on remaining in permission (same-phase re-set)", () => {
    expect(decideEscape(input({ transition: { paneId: "p1", from: "permission", to: "permission" } }))).toEqual(
      { flash: false }
    );
  });

  it("fires entering permission from idle", () => {
    expect(decideEscape(input({ transition: { paneId: "p1", from: "idle", to: "permission" } })).flash).toBe(
      true
    );
  });

  it("never escapes for a transition into working", () => {
    expect(decideEscape(input({ transition: { paneId: "p1", from: "idle", to: "working" } }))).toEqual({
      flash: false,
    });
  });

  it("never escapes for a transition into idle", () => {
    expect(decideEscape(input({ transition: { paneId: "p1", from: "your-move", to: "idle" } }))).toEqual({
      flash: false,
    });
  });
});

describe("decideEscape — your-move (badge-only unless opted in)", () => {
  const enterYourMove = { paneId: "p1", from: "working", to: "your-move" } as const;

  it("badge-only by default: no toast, no flash", () => {
    expect(decideEscape(input({ transition: enterYourMove }))).toEqual({ flash: false });
  });

  it("with the opt-in pref, toasts (but still never flashes)", () => {
    const d = decideEscape(
      input({ transition: enterYourMove, prefs: { osNotifications: true, toastOnTurnComplete: true } })
    );
    expect(d.flash).toBe(false);
    expect(d.toast).toEqual({ title: "✓ Claude finished", body: "api-server" });
  });

  it("opt-in toast is still suppressed when focused + visible", () => {
    const d = decideEscape(
      input({
        transition: enterYourMove,
        windowFocused: true,
        sessionVisible: true,
        prefs: { osNotifications: true, toastOnTurnComplete: true },
      })
    );
    expect(d).toEqual({ flash: false });
  });
});

describe("decideEscape — 3s global toast min-gap", () => {
  it("within the gap: suppresses the toast but STILL flashes (permission)", () => {
    const d = decideEscape(input({ now: 1_000_000, lastToastAt: 1_000_000 - (TOAST_MIN_GAP_MS - 1) }));
    expect(d.toast).toBeUndefined();
    expect(d.flash).toBe(true);
  });

  it("exactly at the gap boundary: toast fires", () => {
    const d = decideEscape(input({ now: 1_000_000, lastToastAt: 1_000_000 - TOAST_MIN_GAP_MS }));
    expect(d.toast).toBeDefined();
  });

  it("within the gap, your-move opt-in produces nothing (no flash either)", () => {
    const d = decideEscape(
      input({
        transition: { paneId: "p1", from: "working", to: "your-move" },
        prefs: { osNotifications: true, toastOnTurnComplete: true },
        now: 1_000_000,
        lastToastAt: 1_000_000 - 500,
      })
    );
    expect(d).toEqual({ flash: false });
  });
});

// ---------------------------------------------------------------------------
// Badge-count parity: the taskbar badge (attentionEscape) and the StatusBar
// chip both derive their count from `needsYouCounts` — the single selector.
// Seeding a fleet and asserting the split proves the number is well-defined and
// that both consumers, calling the same function, get the same answer.
// ---------------------------------------------------------------------------
const agentPane = (phase: PaneAgent["phase"]): PaneAgent => ({
  agent: "claude",
  phase,
  source: "hook",
});
const session = (id: string, paneId: string, over: Partial<Session> = {}): Session =>
  ({
    id,
    name: id,
    layoutRoot: leaf(paneId),
    unread: false,
    working: false,
    ...over,
  }) as Session;

describe("needsYouCounts — badge/StatusBar parity", () => {
  it("counts background permission vs your-move, excluding the visible session", () => {
    const panes: Record<string, PaneAgent> = {
      pa: agentPane("permission"),
      pb: agentPane("your-move"),
      pc: agentPane("permission"), // in the VISIBLE session — must not count
      pd: agentPane("working"), // working never needs you
    };
    const sessions = [
      session("A", "pa"),
      session("B", "pb"),
      session("C", "pc"),
      session("D", "pd"),
    ];
    const visibility = { splitView: null, activeSessionId: "C" };

    const counts = needsYouCounts(panes, sessions, visibility);
    expect(counts).toEqual({ permission: 1, yourMove: 1 });

    // Parity: whatever the StatusBar chip shows split, the badge shows summed —
    // and both come from THIS call, so they cannot disagree.
    const badgeTotal = counts.permission + counts.yourMove;
    expect(badgeTotal).toBe(2);
  });

  it("split view keeps BOTH members from signaling", () => {
    const panes: Record<string, PaneAgent> = {
      pa: agentPane("permission"),
      pb: agentPane("your-move"),
    };
    const sessions = [session("A", "pa"), session("B", "pb")];
    const counts = needsYouCounts(panes, sessions, { splitView: ["A", "B"], activeSessionId: "A" });
    expect(counts).toEqual({ permission: 0, yourMove: 0 });
  });

  it("an unread background session counts as your-move even with no agent", () => {
    const counts = needsYouCounts({}, [session("A", "pa", { unread: true })], {
      splitView: null,
      activeSessionId: null,
    });
    expect(counts).toEqual({ permission: 0, yourMove: 1 });
  });
});

// Repo derivation matrix (Plan 010 Phase B, decision #1). The async resolver is
// tested with an injected `resolveRoot` map — no git — so the three cases the
// plan calls out are pinned deterministically:
//   - multi-pane, SAME repo → one entry
//   - multi-repo            → one entry per distinct root, in order
//   - non-repo panes        → contribute nothing

import { describe, it, expect } from "vitest";

import {
  sessionRepoCandidates,
  deriveRepos,
  type RepoDerivationSession,
  type PaneCwd,
} from "@/lib/diff/repoDerivation";
import { leaf, split } from "@/store/layout/tree";

// A two-pane horizontal layout with the given pane ids.
function twoPaneLayout(a: string, b: string) {
  return split("horizontal", 0.5, leaf(a), leaf(b));
}

describe("sessionRepoCandidates — cwd collection with folderPath fallback", () => {
  it("uses each pane's cwd when present", () => {
    const session: RepoDerivationSession = {
      folderPath: "/proj",
      layoutRoot: twoPaneLayout("p1", "p2"),
    };
    const panes: Record<string, PaneCwd> = {
      p1: { cwd: "/proj/frontend" },
      p2: { cwd: "/proj/backend" },
    };
    expect(sessionRepoCandidates(session, panes)).toEqual([
      "/proj/frontend",
      "/proj/backend",
    ]);
  });

  it("falls back to folderPath for panes with no tracked cwd", () => {
    const session: RepoDerivationSession = {
      folderPath: "/proj",
      layoutRoot: twoPaneLayout("p1", "p2"),
    };
    const panes: Record<string, PaneCwd> = {
      p1: { cwd: null },
      p2: { cwd: null },
    };
    // Both fall back to the same folderPath → deduped to one candidate.
    expect(sessionRepoCandidates(session, panes)).toEqual(["/proj"]);
  });

  it("uses folderPath when the session has no layout", () => {
    const session: RepoDerivationSession = { folderPath: "/solo", layoutRoot: null };
    expect(sessionRepoCandidates(session, {})).toEqual(["/solo"]);
  });

  it("dedupes identical cwds across panes", () => {
    const session: RepoDerivationSession = {
      folderPath: "/proj",
      layoutRoot: twoPaneLayout("p1", "p2"),
    };
    const panes: Record<string, PaneCwd> = {
      p1: { cwd: "/proj/app" },
      p2: { cwd: "/proj/app" },
    };
    expect(sessionRepoCandidates(session, panes)).toEqual(["/proj/app"]);
  });
});

describe("deriveRepos — resolve + dedupe repo roots", () => {
  // A resolver mapping cwds to their repo root (or null for non-repo).
  const resolver = (map: Record<string, string | null>) => async (cwd: string) =>
    map[cwd] ?? null;

  it("multi-pane SAME repo → one root", async () => {
    const session: RepoDerivationSession = {
      folderPath: "/repo",
      layoutRoot: twoPaneLayout("p1", "p2"),
    };
    const panes: Record<string, PaneCwd> = {
      p1: { cwd: "/repo/frontend" },
      p2: { cwd: "/repo/backend" },
    };
    const roots = await deriveRepos(
      session,
      panes,
      resolver({ "/repo/frontend": "/repo", "/repo/backend": "/repo" })
    );
    expect(roots).toEqual(["/repo"]);
  });

  it("multi-repo → one entry per distinct root, first-seen order", async () => {
    const session: RepoDerivationSession = {
      folderPath: "/a",
      layoutRoot: twoPaneLayout("p1", "p2"),
    };
    const panes: Record<string, PaneCwd> = {
      p1: { cwd: "/a/sub" },
      p2: { cwd: "/b" },
    };
    const roots = await deriveRepos(
      session,
      panes,
      resolver({ "/a/sub": "/a", "/b": "/b" })
    );
    expect(roots).toEqual(["/a", "/b"]);
  });

  it("non-repo panes contribute nothing", async () => {
    const session: RepoDerivationSession = {
      folderPath: "/nope",
      layoutRoot: twoPaneLayout("p1", "p2"),
    };
    const panes: Record<string, PaneCwd> = {
      p1: { cwd: "/nope/x" },
      p2: { cwd: "/nope/y" },
    };
    const roots = await deriveRepos(
      session,
      panes,
      resolver({ "/nope/x": null, "/nope/y": null })
    );
    expect(roots).toEqual([]);
  });

  it("mixes repo and non-repo panes", async () => {
    const session: RepoDerivationSession = {
      folderPath: "/w",
      layoutRoot: twoPaneLayout("p1", "p2"),
    };
    const panes: Record<string, PaneCwd> = {
      p1: { cwd: "/w/app" }, // in a repo
      p2: { cwd: "/tmp/scratch" }, // not a repo
    };
    const roots = await deriveRepos(
      session,
      panes,
      resolver({ "/w/app": "/w", "/tmp/scratch": null })
    );
    expect(roots).toEqual(["/w"]);
  });

  it("a throwing resolver is treated as non-repo, never fatal", async () => {
    const session: RepoDerivationSession = { folderPath: "/x", layoutRoot: null };
    const roots = await deriveRepos(session, {}, async () => {
      throw new Error("git exploded");
    });
    expect(roots).toEqual([]);
  });
});

// attemptCreate — pure naming/path helpers (exhaustive matrix) plus the create
// orchestration wiring. git + the home dir are mocked at their client
// boundaries so no Tauri runtime or real filesystem is touched.

import { describe, it, expect, beforeEach, vi } from "vitest";

// Stores pulled in transitively persist via plugin-store; stub it.
vi.mock("@tauri-apps/plugin-store", () => ({
  load: vi.fn(async () => ({
    get: vi.fn(async () => null),
    set: vi.fn(async () => undefined),
    delete: vi.fn(async () => undefined),
    save: vi.fn(async () => undefined),
  })),
}));

const { worktreeAdd } = vi.hoisted(() => ({ worktreeAdd: vi.fn(async () => undefined) }));
vi.mock("@/lib/gitClient", () => ({ gitWorktreeAdd: worktreeAdd }));
vi.mock("@/lib/fsClient", () => ({ homeDir: vi.fn(async () => "C:\\Users\\posan") }));

import {
  slugify,
  uniquifySlug,
  suggestAttemptName,
  attemptPaths,
  shortenHomePath,
  createAttempt,
  buildAttemptPaths,
  MAX_SLUG_LEN,
} from "@/sessions/attemptCreate";
import { useAttemptStore } from "@/store/attemptStore";
import { useSessionsStore } from "@/store/sessionsStore";

describe("slugify", () => {
  it.each([
    ["Fix the parser", "fix-the-parser"],
    ["My Feature!!!", "my-feature"],
    ["  spaced  out  ", "spaced-out"],
    ["already-a-slug", "already-a-slug"],
    ["UPPER_case_Mix", "upper-case-mix"],
    ["dots.and.dots", "dots-and-dots"],
    ["--leading-and-trailing--", "leading-and-trailing"],
    ["snake_case_name", "snake-case-name"],
    ["v1.2.3-rc", "v1-2-3-rc"],
    ["café résumé", "caf-r-sum"],
  ])("slugifies %j → %j", (input, expected) => {
    expect(slugify(input)).toBe(expected);
  });

  it("falls back to 'attempt' for empty / all-punctuation input", () => {
    expect(slugify("")).toBe("attempt");
    expect(slugify("!!!")).toBe("attempt");
    expect(slugify("你好")).toBe("attempt");
    expect(slugify("   ")).toBe("attempt");
  });

  it("caps at MAX_SLUG_LEN and never leaves a trailing dash", () => {
    const long = "a".repeat(50);
    expect(slugify(long)).toHaveLength(MAX_SLUG_LEN);
    // A cut landing on a dash boundary is re-trimmed.
    const dashy = `${"a".repeat(29)}-more`;
    const out = slugify(dashy);
    expect(out.length).toBeLessThanOrEqual(MAX_SLUG_LEN);
    expect(out.endsWith("-")).toBe(false);
  });
});

describe("uniquifySlug", () => {
  it("returns the base when free", () => {
    expect(uniquifySlug("feature", [])).toBe("feature");
    expect(uniquifySlug("feature", ["other"])).toBe("feature");
  });

  it("appends -2, -3 … skipping taken names", () => {
    expect(uniquifySlug("feature", ["feature"])).toBe("feature-2");
    expect(uniquifySlug("feature", ["feature", "feature-2"])).toBe("feature-3");
    expect(uniquifySlug("feature", ["feature", "feature-2", "feature-3"])).toBe("feature-4");
  });

  it("keeps the uniquified slug within the length cap", () => {
    const base = "a".repeat(MAX_SLUG_LEN); // already at the cap
    const taken = [base];
    const out = uniquifySlug(base, taken);
    expect(out.length).toBeLessThanOrEqual(MAX_SLUG_LEN);
    expect(out.endsWith("-2")).toBe(true);
    expect(out.endsWith("--2")).toBe(false); // no dangling dash before the suffix
  });
});

describe("suggestAttemptName", () => {
  it("defaults to <repo>-attempt-1 when nothing is taken", () => {
    expect(suggestAttemptName("myrepo", [])).toBe("myrepo-attempt-1");
  });

  it("skips to the next free N against taken SLUGS", () => {
    // slugify('myrepo-attempt-1') === 'myrepo-attempt-1'
    expect(suggestAttemptName("myrepo", ["myrepo-attempt-1"])).toBe("myrepo-attempt-2");
    expect(
      suggestAttemptName("myrepo", ["myrepo-attempt-1", "myrepo-attempt-2"])
    ).toBe("myrepo-attempt-3");
  });
});

describe("attemptPaths", () => {
  it("builds the Windows worktree home + attempt path", () => {
    const p = attemptPaths("C:\\Users\\posan", "myrepo", "fix-bug");
    expect(p.worktreeHome).toBe("C:\\Users\\posan\\lume\\worktrees\\myrepo");
    expect(p.worktreePath).toBe("C:\\Users\\posan\\lume\\worktrees\\myrepo\\fix-bug");
  });

  it("strips a trailing separator on the home dir", () => {
    const p = attemptPaths("C:\\Users\\posan\\", "r", "s");
    expect(p.worktreePath).toBe("C:\\Users\\posan\\lume\\worktrees\\r\\s");
  });
});

describe("shortenHomePath", () => {
  it("replaces the home prefix with ~ (case-insensitive)", () => {
    const home = "C:\\Users\\posan";
    expect(shortenHomePath("C:\\Users\\posan\\lume\\worktrees\\r\\s", home)).toBe(
      "~\\lume\\worktrees\\r\\s"
    );
    expect(shortenHomePath("c:\\users\\posan\\x", home)).toBe("~\\x");
  });

  it("leaves a non-home path untouched", () => {
    expect(shortenHomePath("D:\\elsewhere\\r", "C:\\Users\\posan")).toBe("D:\\elsewhere\\r");
  });
});

describe("buildAttemptPaths", () => {
  it("resolves the mocked home dir into the worktree path", async () => {
    const p = await buildAttemptPaths("myrepo", "slug");
    expect(p.worktreePath).toBe("C:\\Users\\posan\\lume\\worktrees\\myrepo\\slug");
  });
});

describe("createAttempt orchestration", () => {
  beforeEach(() => {
    worktreeAdd.mockClear();
    useAttemptStore.getState().reset();
    useSessionsStore.getState().reset();
  });

  it("adds the worktree, creates a grouped+active session, records the attempt", async () => {
    const sessionId = await createAttempt({
      repoRoot: "C:\\repos\\myrepo",
      repoName: "myrepo",
      baseBranch: "main",
      attemptName: "Fix the parser",
    });

    // git worktree add ran with the derived path + branch, forked from base.
    expect(worktreeAdd).toHaveBeenCalledTimes(1);
    const [repo, path, branch, base] = worktreeAdd.mock.calls[0] as unknown as [
      string,
      string,
      string,
      string,
    ];
    expect(repo).toBe("C:\\repos\\myrepo");
    expect(path).toBe("C:\\Users\\posan\\lume\\worktrees\\myrepo\\fix-the-parser");
    expect(branch).toBe("lume/fix-the-parser");
    expect(base).toBe("main");

    // Session created on the worktree, active, grouped under the repo name.
    const sessions = useSessionsStore.getState();
    expect(sessions.activeSessionId).toBe(sessionId);
    const session = sessions.sessions[sessionId];
    expect(session.folderPath).toBe(path);
    expect(sessions.groupLabels[path]).toBe("myrepo");

    // Attempt record captured, hint not yet dismissed.
    const attempt = useAttemptStore.getState().attempts[sessionId];
    expect(attempt).toMatchObject({
      repoRoot: "C:\\repos\\myrepo",
      repoName: "myrepo",
      baseBranch: "main",
      branch: "lume/fix-the-parser",
      worktreePath: path,
      hintDismissed: false,
    });
  });

  it("uniquifies the slug against an existing attempt on the same repo", async () => {
    await createAttempt({
      repoRoot: "C:\\repos\\myrepo",
      repoName: "myrepo",
      baseBranch: "main",
      attemptName: "same name",
    });
    await createAttempt({
      repoRoot: "C:\\repos\\myrepo",
      repoName: "myrepo",
      baseBranch: "main",
      attemptName: "same name",
    });
    const branches = Object.values(useAttemptStore.getState().attempts).map((a) => a.branch);
    expect(branches).toContain("lume/same-name");
    expect(branches).toContain("lume/same-name-2");
  });

  it("propagates git's failure and records nothing", async () => {
    worktreeAdd.mockRejectedValueOnce({ kind: "internal", reason: "fatal: branch exists" });
    await expect(
      createAttempt({
        repoRoot: "C:\\repos\\myrepo",
        repoName: "myrepo",
        baseBranch: "main",
        attemptName: "boom",
      })
    ).rejects.toMatchObject({ reason: "fatal: branch exists" });
    expect(Object.keys(useAttemptStore.getState().attempts)).toHaveLength(0);
  });
});

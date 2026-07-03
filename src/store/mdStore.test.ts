// src/store/mdStore.test.ts
import { describe, expect, it, beforeEach, vi } from "vitest";

const confirmMock = vi.hoisted(() => vi.fn(async () => true));

// The persist middleware loads from @tauri-apps/plugin-store on hydrate;
// mock it so the test runner doesn't try to call into Tauri at module load.
vi.mock("@tauri-apps/plugin-store", () => ({
  load: vi.fn(async () => ({
    get: vi.fn(async () => null),
    set: vi.fn(async () => undefined),
    delete: vi.fn(async () => undefined),
  })),
}));

vi.mock("@/store/confirmStore", () => ({
  useConfirmStore: {
    getState: () => ({ confirm: confirmMock }),
  },
}));

import { useMdStore } from "@/store/mdStore";
import { useToastStore } from "@/store/toastStore";

vi.mock("@/lib/fsClient", () => ({
  readTextFile: vi.fn(async (p: string) => `contents of ${p}`),
  readEditorFile: vi.fn(async (p: string) => ({
    content: `contents of ${p}`,
    size: 16,
    tooLarge: false,
    binary: false,
  })),
  writeTextFile: vi.fn(async () => undefined),
}));

// The editor watcher bridges to Rust; stub it so opening/closing tabs doesn't
// reach for Tauri IPC in the test runner.
vi.mock("@/lib/editorWatch", () => ({
  watchEditorFile: vi.fn(async () => undefined),
  unwatchEditorFile: vi.fn(async () => undefined),
  onEditorFileChanged: vi.fn(async () => () => undefined),
}));

// fileSearch is exercised in its own suite; here we stub it so the Quick Viewer
// fallback path is controllable without standing up a fake fs tree.
vi.mock("@/lib/fileSearch", () => ({ findFileByName: vi.fn(async () => null) }));

// Helper to get the mocked fsClient functions with correct types
import * as fsClient from "@/lib/fsClient";
import * as fileSearch from "@/lib/fileSearch";
import * as editorWatch from "@/lib/editorWatch";
const mockedRead = vi.mocked(fsClient.readTextFile);
const mockedReadEditor = vi.mocked(fsClient.readEditorFile);
const mockedWrite = vi.mocked(fsClient.writeTextFile);
const mockedFind = vi.mocked(fileSearch.findFileByName);
const mockedWatch = vi.mocked(editorWatch.watchEditorFile);
const mockedUnwatch = vi.mocked(editorWatch.unwatchEditorFile);

const editorProbe = (content: string, over = false, binary = false) => ({
  content,
  size: content.length,
  tooLarge: over,
  binary,
});

describe("mdStore — Quick Viewer", () => {
  beforeEach(() => {
    useMdStore.getState().reset();
    useToastStore.getState().reset();
    mockedRead.mockImplementation(async (p: string) => `contents of ${p}`);
    mockedFind.mockResolvedValue(null);
    confirmMock.mockReset();
    confirmMock.mockResolvedValue(true);
  });

  it("starts with quick viewer closed", () => {
    const s = useMdStore.getState();
    expect(s.quickViewer.open).toBe(false);
    expect(s.quickViewer.path).toBeNull();
  });

  it("openMdInQuickViewer loads file contents", async () => {
    await useMdStore.getState().openMdInQuickViewer("/tmp/x.md");
    const s = useMdStore.getState();
    expect(s.quickViewer.open).toBe(true);
    expect(s.quickViewer.path).toBe("/tmp/x.md");
    expect(s.quickViewer.content).toBe("contents of /tmp/x.md");
  });

  it("closeQuickViewer resets state", async () => {
    await useMdStore.getState().openMdInQuickViewer("/tmp/x.md");
    useMdStore.getState().closeQuickViewer();
    const s = useMdStore.getState();
    expect(s.quickViewer.open).toBe(false);
    expect(s.quickViewer.path).toBeNull();
    expect(s.quickViewer.content).toBe("");
  });

  it("openMdInQuickViewer last-call-wins when two reads resolve out of order", async () => {
    // Deferred promise for the first read (file A), resolves after file B
    let resolveA!: (v: string) => void;
    const promiseA = new Promise<string>((res) => { resolveA = res; });

    mockedRead
      .mockImplementationOnce(() => promiseA)                         // call 1 → file A, delayed
      .mockImplementationOnce(async () => "contents of /tmp/b.md");  // call 2 → file B, instant

    // Start both opens; B finishes first because its read is synchronous
    const openA = useMdStore.getState().openMdInQuickViewer("/tmp/a.md");
    const openB = useMdStore.getState().openMdInQuickViewer("/tmp/b.md");

    // Let B complete
    await openB;
    expect(useMdStore.getState().quickViewer.path).toBe("/tmp/b.md");

    // Now resolve A's read — it should be ignored because B was newer
    resolveA("contents of /tmp/a.md");
    await openA;

    const s = useMdStore.getState();
    expect(s.quickViewer.path).toBe("/tmp/b.md");
    expect(s.quickViewer.content).toBe("contents of /tmp/b.md");
  });

  it("openMdLinkInQuickViewer falls through to the next candidate when the first read fails", async () => {
    mockedRead.mockImplementation(async (p: string) => {
      if (p === "C:\\cwd/a.md") throw new Error("ENOENT");
      return `contents of ${p}`;
    });

    await useMdStore
      .getState()
      .openMdLinkInQuickViewer(["C:\\cwd/a.md", "C:\\folder/a.md"], "a.md");

    const s = useMdStore.getState();
    expect(s.quickViewer.open).toBe(true);
    expect(s.quickViewer.path).toBe("C:\\folder/a.md");
  });

  it("openMdLinkInQuickViewer toasts and stays closed when no candidate reads", async () => {
    mockedRead.mockImplementation(async () => {
      throw new Error("ENOENT");
    });

    await useMdStore
      .getState()
      .openMdLinkInQuickViewer(["C:\\cwd/missing.md"], "missing.md");

    expect(useMdStore.getState().quickViewer.open).toBe(false);
    const toasts = useToastStore.getState().toasts;
    expect(toasts.length).toBe(1);
    expect(toasts[0].severity).toBe("warn");
    expect(toasts[0].message).toContain("missing.md");
  });

  it("searches the session folder for a bare filename when direct candidates miss", async () => {
    mockedRead.mockImplementation(async (p: string) => {
      if (p === "C:\\proj\\docs\\PLAN.md") return "found via search";
      throw new Error("ENOENT");
    });
    mockedFind.mockResolvedValue("C:\\proj\\docs\\PLAN.md");

    await useMdStore
      .getState()
      .openMdLinkInQuickViewer(["C:\\proj\\PLAN.md"], "PLAN.md", "C:\\proj");

    expect(mockedFind).toHaveBeenCalledWith("C:\\proj", "PLAN.md");
    const s = useMdStore.getState();
    expect(s.quickViewer.open).toBe(true);
    expect(s.quickViewer.path).toBe("C:\\proj\\docs\\PLAN.md");
  });

  it("toasts when the search fallback also misses", async () => {
    mockedRead.mockImplementation(async () => {
      throw new Error("ENOENT");
    });
    mockedFind.mockResolvedValue(null);

    await useMdStore
      .getState()
      .openMdLinkInQuickViewer(["C:\\proj\\missing.md"], "missing.md", "C:\\proj");

    expect(useMdStore.getState().quickViewer.open).toBe(false);
    expect(
      useToastStore.getState().toasts.some((t) => t.message.includes("missing.md"))
    ).toBe(true);
  });
});

describe("mdStore — MD Editor tabs", () => {
  beforeEach(() => {
    useMdStore.getState().reset();
    useToastStore.getState().reset();
    mockedRead.mockImplementation(async (p: string) => `contents of ${p}`);
    mockedReadEditor.mockImplementation(async (p: string) => editorProbe(`contents of ${p}`));
    mockedWrite.mockImplementation(async () => undefined);
    mockedWatch.mockClear();
    mockedUnwatch.mockClear();
    confirmMock.mockReset();
    confirmMock.mockResolvedValue(true);
  });

  it("openMdTab called twice concurrently for the same path results in exactly one tab", async () => {
    // Both calls will pass the pre-await dedup check (tabs is empty at that point)
    // and then both await the same deferred read. The post-await re-check should
    // ensure only one tab ends up in state.
    let resolveRead!: (v: ReturnType<typeof editorProbe>) => void;
    const pendingRead = new Promise<ReturnType<typeof editorProbe>>((res) => {
      resolveRead = res;
    });
    mockedReadEditor.mockImplementation(() => pendingRead);

    const p1 = useMdStore.getState().openMdTab("/tmp/same.md");
    const p2 = useMdStore.getState().openMdTab("/tmp/same.md");

    // Unblock both reads at once
    resolveRead(editorProbe("hello"));
    await Promise.all([p1, p2]);

    const { tabs } = useMdStore.getState();
    expect(tabs.length).toBe(1);
    expect(tabs[0].path).toBe("/tmp/same.md");
  });

  it("closeMdTab keeps a dirty tab open when discard is cancelled", async () => {
    await useMdStore.getState().openMdTab("/tmp/dirty.md");
    const { tabs } = useMdStore.getState();
    const id = tabs[0].id;

    // Mark the tab dirty by editing its content
    useMdStore.getState().setTabContent(id, "edited content");
    expect(useMdStore.getState().tabs[0].dirty).toBe(true);

    confirmMock.mockResolvedValueOnce(false);
    const closed = await useMdStore.getState().closeMdTab(id);

    expect(closed).toBe(false);
    expect(useMdStore.getState().tabs.some((t) => t.id === id)).toBe(true);
    expect(confirmMock).toHaveBeenCalledOnce();
  });

  it("closeMdTab closes a dirty tab after discard is confirmed", async () => {
    await useMdStore.getState().openMdTab("/tmp/dirty.md");
    const { tabs } = useMdStore.getState();
    const id = tabs[0].id;

    useMdStore.getState().setTabContent(id, "edited content");
    confirmMock.mockResolvedValueOnce(true);
    const closed = await useMdStore.getState().closeMdTab(id);

    expect(closed).toBe(true);
    expect(useMdStore.getState().tabs.some((t) => t.id === id)).toBe(false);
    expect(confirmMock).toHaveBeenCalledOnce();
  });

  it("closeMdTab on a clean tab does not prompt or toast", async () => {
    await useMdStore.getState().openMdTab("/tmp/clean.md");
    const { tabs } = useMdStore.getState();
    const id = tabs[0].id;

    expect(tabs[0].dirty).toBe(false);

    const closed = await useMdStore.getState().closeMdTab(id);

    expect(closed).toBe(true);
    expect(confirmMock).not.toHaveBeenCalled();
    const toasts = useToastStore.getState().toasts;
    expect(toasts.length).toBe(0);
  });

  it("saveMdTab keeps dirty === true when content changes during the write", async () => {
    await useMdStore.getState().openMdTab("/tmp/race.md");
    const { tabs } = useMdStore.getState();
    const id = tabs[0].id;

    // Make the tab dirty first
    useMdStore.getState().setTabContent(id, "version 1");

    // Deferred write — we control when it resolves
    let resolveWrite!: () => void;
    mockedWrite.mockImplementationOnce(
      () => new Promise<void>((res) => { resolveWrite = res; }),
    );

    // Start the save (it is now awaiting the write)
    const savePromise = useMdStore.getState().saveMdTab(id);

    // Simulate user typing while the write is still in-flight
    useMdStore.getState().setTabContent(id, "version 2");

    // Resolve the write
    resolveWrite();
    await savePromise;

    // The tab content is now "version 2" which differs from "version 1" that
    // was written; dirty must stay true.
    const tab = useMdStore.getState().tabs.find((t) => t.id === id);
    expect(tab?.content).toBe("version 2");
    expect(tab?.dirty).toBe(true);
  });
});

describe("mdStore — open guards + kind (Plan 010 §1/§2)", () => {
  beforeEach(() => {
    useMdStore.getState().reset();
    useToastStore.getState().reset();
    mockedReadEditor.mockImplementation(async (p: string) => editorProbe(`contents of ${p}`));
    mockedWatch.mockClear();
  });

  it("opens a code file as kind=code and registers a watcher", async () => {
    await useMdStore.getState().openMdTab("/proj/src/main.rs");
    const tab = useMdStore.getState().tabs[0];
    expect(tab.kind).toBe("code");
    expect(tab.readOnly).toBe(false);
    expect(mockedWatch).toHaveBeenCalledWith("/proj/src/main.rs");
  });

  it("opens a markdown file as kind=markdown", async () => {
    await useMdStore.getState().openMdTab("/proj/README.md");
    expect(useMdStore.getState().tabs[0].kind).toBe("markdown");
  });

  it("refuses a binary file with a toast and opens no tab", async () => {
    mockedReadEditor.mockImplementationOnce(async () => editorProbe("", false, true));
    await useMdStore.getState().openMdTab("/proj/logo.png");
    expect(useMdStore.getState().tabs.length).toBe(0);
    const toasts = useToastStore.getState().toasts;
    expect(toasts.length).toBe(1);
    expect(toasts[0].message).toContain("logo.png");
  });

  it("opens an oversized file read-only and ignores edits", async () => {
    mockedReadEditor.mockImplementationOnce(async () => editorProbe("huge", true));
    await useMdStore.getState().openMdTab("/proj/big.log");
    const id = useMdStore.getState().tabs[0].id;
    expect(useMdStore.getState().tabs[0].readOnly).toBe(true);
    useMdStore.getState().setTabContent(id, "attempted edit");
    const tab = useMdStore.getState().tabs[0];
    expect(tab.content).toBe("huge");
    expect(tab.dirty).toBe(false);
  });
});

describe("mdStore — external change watcher matrix (Plan 010 §3)", () => {
  beforeEach(() => {
    useMdStore.getState().reset();
    useToastStore.getState().reset();
    mockedReadEditor.mockImplementation(async (p: string) => editorProbe(`contents of ${p}`));
    mockedRead.mockImplementation(async (p: string) => `contents of ${p}`);
    mockedWrite.mockImplementation(async () => undefined);
    mockedWatch.mockClear();
  });

  it("clean tab silently reloads from disk", async () => {
    await useMdStore.getState().openMdTab("/w/a.txt");
    const id = useMdStore.getState().tabs[0].id;
    // Disk now differs from the (clean) buffer.
    mockedRead.mockImplementationOnce(async () => "external new content");

    await useMdStore.getState().handleExternalChange("/w/a.txt");

    const tab = useMdStore.getState().tabs.find((t) => t.id === id)!;
    expect(tab.content).toBe("external new content");
    expect(tab.dirty).toBe(false);
    expect(tab.conflict).toBeNull();
  });

  it("dirty tab raises a conflict bar instead of clobbering edits", async () => {
    await useMdStore.getState().openMdTab("/w/b.txt");
    const id = useMdStore.getState().tabs[0].id;
    useMdStore.getState().setTabContent(id, "my unsaved edits");
    mockedRead.mockImplementationOnce(async () => "agent rewrote this");

    await useMdStore.getState().handleExternalChange("/w/b.txt");

    const tab = useMdStore.getState().tabs.find((t) => t.id === id)!;
    expect(tab.content).toBe("my unsaved edits"); // buffer untouched
    expect(tab.dirty).toBe(true);
    expect(tab.conflict).toEqual({ diskContent: "agent rewrote this" });
  });

  it("reloadTab adopts the disk content and clears the conflict", async () => {
    await useMdStore.getState().openMdTab("/w/c.txt");
    const id = useMdStore.getState().tabs[0].id;
    useMdStore.getState().setTabContent(id, "mine");
    mockedRead.mockImplementationOnce(async () => "theirs");
    await useMdStore.getState().handleExternalChange("/w/c.txt");

    useMdStore.getState().reloadTab(id);
    const tab = useMdStore.getState().tabs.find((t) => t.id === id)!;
    expect(tab.content).toBe("theirs");
    expect(tab.dirty).toBe(false);
    expect(tab.conflict).toBeNull();
  });

  it("keepConflictMine dismisses the bar but keeps the dirty buffer", async () => {
    await useMdStore.getState().openMdTab("/w/d.txt");
    const id = useMdStore.getState().tabs[0].id;
    useMdStore.getState().setTabContent(id, "mine");
    mockedRead.mockImplementationOnce(async () => "theirs");
    await useMdStore.getState().handleExternalChange("/w/d.txt");

    useMdStore.getState().keepConflictMine(id);
    const tab = useMdStore.getState().tabs.find((t) => t.id === id)!;
    expect(tab.content).toBe("mine");
    expect(tab.dirty).toBe(true);
    expect(tab.conflict).toBeNull();
  });

  it("our own save does NOT raise a conflict (self-write suppression)", async () => {
    await useMdStore.getState().openMdTab("/w/e.txt");
    const id = useMdStore.getState().tabs[0].id;
    useMdStore.getState().setTabContent(id, "v1");
    await useMdStore.getState().saveMdTab(id);

    // Simulate the watcher echo landing right after our write. Even though the
    // read returns something different (as if the user typed mid-write), the
    // self-write flag must suppress the conflict bar.
    mockedRead.mockImplementationOnce(async () => "v1-on-disk");
    await useMdStore.getState().handleExternalChange("/w/e.txt");

    const tab = useMdStore.getState().tabs.find((t) => t.id === id)!;
    expect(tab.conflict).toBeNull();
  });

  it("no-op when the changed path has no open tab", async () => {
    await useMdStore.getState().handleExternalChange("/w/not-open.txt");
    expect(useMdStore.getState().tabs.length).toBe(0);
  });

  it("ignores an echo whose disk content equals the buffer", async () => {
    await useMdStore.getState().openMdTab("/w/f.txt");
    const id = useMdStore.getState().tabs[0].id;
    // Disk read returns exactly the buffer (default mock) → treated as no change.
    await useMdStore.getState().handleExternalChange("/w/f.txt");
    const tab = useMdStore.getState().tabs.find((t) => t.id === id)!;
    expect(tab.conflict).toBeNull();
    expect(tab.dirty).toBe(false);
  });
});

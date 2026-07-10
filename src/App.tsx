// Lume root. Horizontal flex layout, left → right:
//   SessionsSidebar (sessions grouped by folder; toggled by ☰ / Ctrl+B)
//   FileDrawer      (active session's file tree; toggled by 🗂 / Ctrl+Shift+E,
//                    renders null when the active session's fileTreeOpen is false)
//   central area    (MainArea PaneTree mux + optional MD Quick Viewer panel)
//
// The central area is a horizontal PanelGroup so the MD Quick Viewer can dock
// on the right (default 25%, min 20%, max 60%) when open.
//
// When MD Editor mode is "full", the entire central area is replaced by the
// <MdEditor /> per CONTEXT.md: "the Tiling Area + MD Quick Viewer area are
// replaced by a single full-width CodeMirror 6 editor with the open MD Tabs
// across the top. The Sidebar remains visible." The sidebars and the
// ContextMenu portal stay mounted alongside.

import { Suspense, lazy, useEffect, useRef } from "react";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";

import { ConfirmDialog } from "@/components/ConfirmDialog";
import { ContextMenu } from "@/components/ContextMenu";
import { FileDrawer } from "@/components/FileDrawer";
import { MainArea } from "@/components/MainArea";
// Lazy: the Editor pulls in CodeMirror + (dynamically) language grammars. It
// only mounts when Editor Full View is active, so defer the whole chunk until
// then (Plan 010 §1 — keep language loading + editor surface off first paint).
const MdEditor = lazy(() => import("@/components/MdEditor"));
// Lazy: the Diff tab pulls in @codemirror/merge + (dynamically) language
// grammars. It only mounts when the Diff surface is open, so defer the chunk
// (Plan 010 Phase B — same rationale as the Editor above).
const DiffView = lazy(() => import("@/components/DiffView"));
import { Preview } from "@/components/Preview";
import { QuickViewer } from "@/components/QuickViewer";
import { SessionsSidebar } from "@/components/SessionsSidebar";
import { SettingsModal } from "@/components/SettingsModal";
import { ShortcutsModal } from "@/components/ShortcutsModal";
import { SplitMenu } from "@/components/SplitMenu";
import { CoachChip } from "@/components/CoachChip";
import { NewAttemptPopover } from "@/components/NewAttemptPopover";
import { StatusBar } from "@/components/StatusBar";
import { Toaster } from "@/components/Toaster";
import { TopBar } from "@/components/TopBar";
import { beginResize, endResize } from "@/components/resizeBus";
import { installBranchPoller } from "@/sessions/branchPoller";
import { installAgentTracker } from "@/sessions/agentTracker";
import { installAttentionEscape } from "@/sessions/attentionEscape";
import { claudeHooksStatus, installClaudeHooks } from "@/lib/claudeHooksClient";
import { initCoach, disposeCoach } from "@/sessions/coach";
import { onCommandEvent } from "@/sessions/commandTracker";
import { runMigrationIfNeeded } from "@/sessions/migration";
import { leaves } from "@/store/layout/tree";
import { useLayoutStore } from "@/store/layoutStore";
import { useMdStore } from "@/store/mdStore";
import { useDiffStore } from "@/store/diffStore";
import { usePreviewStore } from "@/store/previewStore";
import { paneLaunchSpec, useSessionsStore } from "@/store/sessionsStore";
import { useSettingsStore } from "@/store/settingsStore";
import { usePaneResumeStore } from "@/store/paneResumeStore";
import { useAttemptStore, reconcileAttempts } from "@/store/attemptStore";
import { useSidebarStore } from "@/store/sidebarStore";
import { applyXtermFontFamilyToAll, applyXtermThemeToAll } from "@/terminals/registry";
import { installPtyOrchestrator } from "@/terminals/orchestrator";
import { installRenderGovernor } from "@/terminals/renderGovernor";
import { onEditorFileChanged } from "@/lib/editorWatch";
import { useExternalFileDrop } from "@/hooks/useExternalFileDrop";
import { useKeyboardShortcuts } from "@/hooks/useKeyboardShortcuts";
import { nextPaneId } from "@/lib/paneIds";
import { sequentialResume } from "@/lib/sessions/sequentialResume";
import { coerceThemeName } from "@/lib/themes";
import { coerceFontPair } from "@/lib/fontPairs";
import { checkForUpdatesOnLaunch } from "@/lib/updater";

/** Resolve once the resume store has loaded from disk (Plan 009). Its records
 *  are re-keyed by the sessionsStore rehydrate, so we only need to wait for the
 *  load to complete — the remap has already been applied by then. */
function whenPaneResumeHydrated(): Promise<void> {
  if (usePaneResumeStore.persist.hasHydrated()) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const unsub = usePaneResumeStore.persist.onFinishHydration(() => {
      unsub();
      resolve();
    });
  });
}

export default function App() {
  // The Quick Viewer belongs to the session that opened it — a glance panel is
  // project-scoped, so it must not follow you into other sessions. It counts as
  // "open" (drives the layout below AND the mutual-exclusion effect) only while
  // its owning session is the active one.
  const activeSessionId = useSessionsStore((s) => s.activeSessionId);
  const quickViewerOwner = useMdStore((s) => s.quickViewer.sessionId);
  const quickViewerRawOpen = useMdStore((s) => s.quickViewer.open);
  const quickViewerOpen = quickViewerRawOpen && quickViewerOwner === activeSessionId;
  const previewOpen = usePreviewStore((s) => s.open);
  const mdMode = useMdStore((s) => s.mdEditorMode);
  const diffOpen = useDiffStore((s) => s.open);
  const splitView = useSessionsStore((s) => s.splitView);

  // Session split-view is mutually exclusive with the other central-area
  // surfaces (Quick Viewer / Preview / MD Editor Full View / Diff tab) — the v1
  // decision. One transition-based guard so the LATEST action wins (no
  // who-fired-first race): if the split just opened it closes the panels; if a
  // panel/full surface just opened while a split was up, it collapses the split.
  // The two full-area surfaces (Editor Full View, Diff) are ALSO mutually
  // exclusive with each other — opening one closes the other so App never has to
  // pick between two "full" branches.
  const prevSplit = useRef(splitView);
  const prevSurfaces = useRef({
    qv: quickViewerOpen,
    pv: previewOpen,
    md: mdMode,
    diff: diffOpen,
  });
  useEffect(() => {
    const splitJustOpened = !prevSplit.current && !!splitView;
    const mdJustOpened = prevSurfaces.current.md !== "full" && mdMode === "full";
    const diffJustOpened = !prevSurfaces.current.diff && diffOpen;
    const surfaceJustOpened =
      (!prevSurfaces.current.qv && quickViewerOpen) ||
      (!prevSurfaces.current.pv && previewOpen) ||
      mdJustOpened ||
      diffJustOpened;

    if (splitJustOpened) {
      if (useMdStore.getState().quickViewer.open) useMdStore.getState().closeQuickViewer();
      if (usePreviewStore.getState().open) usePreviewStore.getState().closePreview();
      if (useDiffStore.getState().open) useDiffStore.getState().closeDiff();
    } else if (surfaceJustOpened && splitView) {
      useSessionsStore.getState().closeSplit();
    }

    // Full-area surface arbitration: whichever of Editor / Diff opened last wins.
    if (diffJustOpened && useMdStore.getState().mdEditorMode === "full") {
      useMdStore.getState().setMdEditorMode("off");
    }
    if (mdJustOpened && useDiffStore.getState().open) {
      useDiffStore.getState().closeDiff();
    }

    prevSplit.current = splitView;
    prevSurfaces.current = {
      qv: quickViewerOpen,
      pv: previewOpen,
      md: mdMode,
      diff: diffOpen,
    };
  }, [splitView, quickViewerOpen, previewOpen, mdMode, diffOpen]);

  // The Diff tab is session-scoped (unlike the global Editor tabs): re-derive
  // its repo set + file list when the active session changes while it's open, so
  // switching sessions with the diff up shows the new session's repo, not a
  // stale one. Guarded on `open` so it's a no-op when the surface is closed.
  // (activeSessionId is declared at the top — the Quick Viewer scoping needs it too.)
  useEffect(() => {
    if (useDiffStore.getState().open) void useDiffStore.getState().openDiff();
  }, [activeSessionId]);

  useEffect(() => {
    const dispose = installPtyOrchestrator();
    // Render governor: of the active sessions the orchestrator keeps running,
    // only the on-screen one(s) render live + hold a WebGL context; background
    // sessions buffer their output and replay on return. Bounds Lume's cost to
    // what's visible. Installed after the orchestrator so the panes it spawns
    // exist; seeds visibility immediately and tracks it thereafter.
    const disposeGovernor = installRenderGovernor();
    const disposePoller = installBranchPoller();
    // Deterministic agent-state detection (Plan 008): subscribe to the Rust
    // `agent-event` stream so hooked Claude Code sessions drive the sidebar's
    // precise signals instead of the output-cadence guess.
    const disposeAgentTracker = installAgentTracker();
    // Hook reconcile: users who enabled Precise Claude Code signals BEFORE the
    // SubagentStart/SubagentStop events existed have an install that's missing
    // them. If our hooks are already present, re-run the (idempotent, additive)
    // install once at boot to top up the new events — nothing else is touched,
    // and a disabled/absent install is left alone. Fully best-effort.
    void claudeHooksStatus()
      .then((installed) => {
        if (installed) return installClaudeHooks();
      })
      .catch(() => {
        /* degrade silently — the toggle still works on demand */
      });
    // Attention escape (Plan 011): carry the class-A signals OUT of the window —
    // OS toast on a permission block, taskbar flash, and an overlay badge with
    // the fleet needs-you count — for the minimized/unfocused case.
    const disposeAttentionEscape = installAttentionEscape();
    // Workflow coach (Plan 014): wire the detectors + graduation seams + the
    // gate-6 pane-slot predicate. Master-switch guarded internally, so it is
    // safe to install unconditionally; it observes nothing while tips are off.
    initCoach();
    let cancelResume: (() => void) | undefined;

    const bootstrap = async () => {
      // By the time this runs, sessionsStore has rehydrated and
      // coerceRehydrated has set every persisted session to stopped with
      // activeSessionId null. runMigrationIfNeeded seeds a session on fresh
      // install / v0.1 upgrade (returning its id to activate) or returns null
      // on a routine restart (persisted sessions stay all-stopped per §3).
      const oldRoot = useLayoutStore.getState().root; // façade → null at cold start
      const oldWs = useSidebarStore.getState().workspaceFolder;
      const seededId = await runMigrationIfNeeded({
        oldLayoutRoot: oldRoot,
        oldWorkspaceFolder: oldWs,
      });
      if (seededId) {
        useSessionsStore.getState().activateSession(seededId);
      }

      // Feature A — reopen the fleet on launch. Revives the sessions that
      // were running at last exit (persisted as lastRunningSessionIds) ONE AT
      // A TIME: the last-active session immediately, each further session
      // only once the previous one's autorun panes reported OSC 133
      // prompt-ready (or a timeout). Reviving the whole fleet in one store
      // write made the orchestrator spawn every pane — and auto-run every
      // remembered `claude` — in the same second, which froze the machine
      // into a force-close → re-stampede loop (2026-06-12 incident). Each
      // single-session revive is the same code path as clicking that session
      // in the sidebar: status flips → orchestrator diff → panes spawn.
      if (!seededId) {
        // Plan 009: the resume store (paneId-keyed, remapped to match this
        // launch's fresh ids) must be hydrated before we revive, so reviveSpawn
        // reads each pane's resume record and offers Resume instead of blindly
        // re-running the raw launch command.
        await whenPaneResumeHydrated();
        const st = useSessionsStore.getState();
        if (st.reopenLastSession && st.lastRunningSessionIds.length > 0) {
          cancelResume = sequentialResume(
            st.lastRunningSessionIds,
            st.lastActiveSessionId,
            {
              resumeOne: st.resumeSessions,
              onPaneReady: (cb) =>
                onCommandEvent((evt) => {
                  if (evt.type === "prompt-ready") cb(evt.paneId);
                }),
              autorunPaneIds: (sid) => {
                const state = useSessionsStore.getState();
                const sess = state.sessions[sid];
                if (!sess?.layoutRoot) return [];
                return leaves(sess.layoutRoot).filter(
                  (paneId) => !!paneLaunchSpec(state, paneId)?.startupCommand?.trim()
                );
              },
            }
          );
        }
      }

      // If the now-active session has no layout yet, seed its first pane. On a
      // routine restart nothing is active, so this is skipped and the user
      // sees the all-stopped sidebar until they click a session to revive.
      const layout = useLayoutStore.getState();
      if (layout.root === null && useSessionsStore.getState().activeSessionId !== null) {
        layout.initWithFirstPane(nextPaneId());
      }
    };

    // Gate on sessionsStore hydration — sessions live there now. Running before
    // it rehydrates would seed a stray home session that the wholesale
    // rehydrate setState then wipes (spawn-then-orphan flash). layoutStore's
    // own persist is a no-op shim (partialize () => ({})); its bridge
    // re-mirrors after sessionsStore hydrates, so gating here is sufficient.
    let unsubFinishHydration: (() => void) | undefined;
    if (useSessionsStore.persist.hasHydrated()) {
      void bootstrap();
    } else {
      unsubFinishHydration = useSessionsStore.persist.onFinishHydration(() => {
        void bootstrap();
      });
    }

    return () => {
      if (unsubFinishHydration) unsubFinishHydration();
      cancelResume?.();
      disposeCoach();
      disposeAttentionEscape();
      disposeAgentTracker();
      disposePoller();
      disposeGovernor();
      dispose();
    };
  }, []);

  // Editor external-change bridge (Plan 010 §3): route the Rust `file-changed`
  // stream into the store, which decides silent-reload vs conflict-bar per tab.
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void onEditorFileChanged((path) => {
      void useMdStore.getState().handleExternalChange(path);
    })
      .then((un) => {
        // If the component already unmounted, drop the listener immediately.
        if (disposed) un();
        else unlisten = un;
      })
      .catch((err) => console.warn("editor watch bridge: listen failed", err));
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  // Attempt reconcile (Plan 013): once the attempt store has loaded, ask git for
  // the real worktree list per repo and drop records whose folder is gone (user
  // deleted it outside Lume), toasting once each. Fully best-effort — it must
  // never block or crash boot, so failures degrade silently inside the helper.
  useEffect(() => {
    let cancelled = false;
    const run = () => {
      if (!cancelled) void reconcileAttempts();
    };
    if (useAttemptStore.persist.hasHydrated()) {
      run();
      return;
    }
    const unsub = useAttemptStore.persist.onFinishHydration(run);
    return () => {
      cancelled = true;
      unsub();
    };
  }, []);

  // Update check — runs once at boot in release builds only.
  // Dev builds have no updater endpoint, so we guard on import.meta.env.PROD
  // to avoid noisy network errors during development.
  useEffect(() => {
    if (import.meta.env.PROD) {
      void checkForUpdatesOnLaunch();
    }
  }, []);

  // Theme application — settings.theme.accent → data-theme on :root.
  // CSS modules read the swapped --bg/--fg/--accent variables, then every
  // live xterm Terminal gets its theme re-applied so the WebGL atlas
  // regenerates against the new palette. Atomic selector so we re-run only
  // when the accent name changes, not on every settings field write.
  const themeAccent = useSettingsStore((s) => s.config.theme.accent);
  useEffect(() => {
    const name = coerceThemeName(themeAccent);
    document.documentElement.setAttribute("data-theme", name);
    applyXtermThemeToAll();
  }, [themeAccent]);

  // Font pair application — settings.font.pair → data-font-pair on :root.
  // CSS swaps --font-ui and --font-mono atomically; xterm then needs an
  // explicit fontFamily push so existing Terminals re-measure cells against
  // the new mono. New Terminals already pick the resolved stack up via
  // registry.ts reading --font-mono at construction.
  const fontPair = useSettingsStore((s) => s.config.font.pair);
  useEffect(() => {
    const name = coerceFontPair(fontPair);
    document.documentElement.setAttribute("data-font-pair", name);
    applyXtermFontFamilyToAll();
  }, [fontPair]);

  // Wire keyboard shortcuts (W2-P3): split/focus/close.
  useKeyboardShortcuts();

  useExternalFileDrop();

  return (
    <div
      style={{
        width: "100vw",
        height: "100vh",
        background: "var(--bg-0)",
        display: "flex",
        flexDirection: "column",
        boxSizing: "border-box",
      }}
    >
      <TopBar />
      <div
        style={{
          flex: 1,
          minHeight: 0,
          display: "flex",
          flexDirection: "row",
        }}
      >
        {/* Always mounted — SessionsSidebar animates its own width collapse from
            sidebarStore.sidebarVisible (☰ / Ctrl+B). Gating with `&&` here would
            mount/unmount it instantly and defeat the open/close animation. */}
        <SessionsSidebar />
        {/* FileDrawer renders null unless the active session has fileTreeOpen.
            Its visibility is owned by the 🗂 topbar toggle (and Ctrl+Shift+E),
            independent of the sessions-sidebar visibility (☰ / Ctrl+B). */}
        <FileDrawer />
        <div style={{ flex: 1, minWidth: 0, position: "relative" }}>
          {diffOpen ? (
            // Diff takes precedence over the Editor when both flags linger for a
            // frame; the arbitration effect above then turns the Editor off.
            <Suspense fallback={<div style={{ width: "100%", height: "100%", background: "var(--bg-0)" }} />}>
              <DiffView />
            </Suspense>
          ) : mdMode === "full" ? (
            // Fallback matches the editor bg so the lazy-chunk load doesn't flash.
            <Suspense fallback={<div style={{ width: "100%", height: "100%", background: "var(--bg-0)" }} />}>
              <MdEditor />
            </Suspense>
          ) : (
            <PanelGroup
              direction="horizontal"
              id="pg-root-h"
              key={`pg-root-${quickViewerOpen ? 1 : 0}-${previewOpen ? 1 : 0}`}
            >
              <Panel
                defaultSize={
                  quickViewerOpen && previewOpen
                    ? 45
                    : previewOpen
                      ? 55
                      : quickViewerOpen
                        ? 75
                        : 100
                }
                minSize={40}
              >
                <MainArea />
              </Panel>
              {quickViewerOpen && (
                <>
                  <PanelResizeHandle
                    // Mirror PaneTree's splitter: gate xterm fit() during the drag
                    // through resizeBus so the WebGL canvas-clear flicker doesn't
                    // hit Terminal Panes inside the left Panel while this handle
                    // is being dragged. Without this hook, every drag tick would
                    // schedule a term.fit() per pane, clearing the framebuffer.
                    onDragging={(isDragging) => {
                      if (isDragging) beginResize();
                      else endResize();
                    }}
                    style={{ width: 3, background: "var(--border)", cursor: "col-resize" }}
                  />
                  <Panel defaultSize={25} minSize={20} maxSize={60}>
                    <QuickViewer />
                  </Panel>
                </>
              )}
              {previewOpen && (
                <>
                  <PanelResizeHandle
                    onDragging={(isDragging) => {
                      if (isDragging) beginResize();
                      else endResize();
                    }}
                    style={{ width: 3, background: "var(--border)", cursor: "col-resize" }}
                  />
                  <Panel defaultSize={quickViewerOpen ? 30 : 45} minSize={25} maxSize={70}>
                    <Preview />
                  </Panel>
                </>
              )}
            </PanelGroup>
          )}
        </div>
      </div>
      <StatusBar />
      <ContextMenu />
      <Toaster />
      <ConfirmDialog />
      <SplitMenu />
      {/* Session-pair coach chip (Plan 014) — mounted once; renders only when
          activeTip is a session-pair anchor. Pane-anchored chips live inside
          each TerminalPane instead. */}
      <CoachChip />
      <NewAttemptPopover />
      <ShortcutsModal />
      <SettingsModal />
    </div>
  );
}

// SettingsModal — GUI editor over config.toml. Reads settingsStore; writes via
// setConfigValue (optimistic + format-preserving disk write). Motion + overlay
// pattern identical to ShortcutsModal (usePresence + data-state).

import { useEffect, useState } from "react";

import styles from "@/components/SettingsModal.module.css";
import { usePresence } from "@/hooks/usePresence";
import { useSettingsModalStore, type SettingsCategory } from "@/store/settingsModalStore";
import { useSettingsStore } from "@/store/settingsStore";
import { SettingRow } from "@/components/settings/SettingRow";
import { Toggle } from "@/components/settings/Toggle";
import { Stepper } from "@/components/settings/Stepper";
import { Dropdown } from "@/components/settings/Dropdown";
import { Segmented } from "@/components/settings/Segmented";
import { ChipList } from "@/components/settings/ChipList";
import { configFilePath } from "@/lib/configClient";
import {
  claudeHooksStatus,
  installClaudeHooks,
  uninstallClaudeHooks,
} from "@/lib/claudeHooksClient";
import { useAgentStore } from "@/store/agentStore";
import { usePaneResumeStore } from "@/store/paneResumeStore";
import { usePrefsStore } from "@/store/prefsStore";
import { useToastStore } from "@/store/toastStore";
import { useMdStore } from "@/store/mdStore";
import { detectShells, shellLabel, shellToConfigId } from "@/lib/shellsClient";
import type { Shell } from "@/types";
import type { ThemeName } from "@/lib/themes";
import { FONT_PAIRS } from "@/lib/fontPairs";
import { IconClose } from "@/components/icons";

const CATEGORIES: { id: SettingsCategory; label: string }[] = [
  { id: "appearance", label: "Appearance" },
  { id: "terminal", label: "Terminal" },
  { id: "editor", label: "Editor" },
  { id: "sidebar", label: "Sidebar" },
  { id: "agents", label: "Agents" },
];

// Theme presets — the four curated palettes that ship in v0.2. Swatch color
// is each theme's accent; clicking sets data-theme on :root via the App-level
// effect (App.tsx) and re-applies the xterm theme to every live Terminal.
// Single source of truth for the palette set lives in src/lib/themes.ts.
const ACCENT_PRESETS: { id: ThemeName; label: string; color: string }[] = [
  { id: "cobalt", label: "Cobalt", color: "#5fa8ff" },
  { id: "coral", label: "Coral", color: "#ff8a65" },
  { id: "tokyo", label: "Tokyo Night", color: "#7dcfff" },
  { id: "gruvbox", label: "Gruvbox", color: "#fe8019" },
];

export function SettingsModal() {
  const open = useSettingsModalStore((s) => s.open);
  const close = useSettingsModalStore((s) => s.closeModal);
  const category = useSettingsModalStore((s) => s.category);
  const setCategory = useSettingsModalStore((s) => s.setCategory);
  const { mounted, state } = usePresence(open, 160);

  const config = useSettingsStore((s) => s.config);
  const set = useSettingsStore((s) => s.setConfigValue);

  const [shells, setShells] = useState<Shell[]>([]);
  useEffect(() => {
    if (!open) return;
    void detectShells().then(setShells).catch(() => setShells([]));
  }, [open]);

  // "Precise Claude Code signals" toggle (Plan 008 §5). `hooksInstalled` is the
  // on-disk truth (our shim path is the marker in ~/.claude/settings.json), not
  // a persisted preference — re-queried each time the modal opens.
  const [hooksInstalled, setHooksInstalled] = useState<boolean | null>(null);
  const [hooksBusy, setHooksBusy] = useState(false);
  const sawSessionStart = useAgentStore((s) => s.sawSessionStart);

  // Auto-resume preference (Plan 009). Lives in paneResumeStore, not
  // settingsStore/config.toml — it's a behavioural preference (like the
  // sessions store's reopenLastSession), not a config.toml key.
  const autoResume = usePaneResumeStore((s) => s.autoResumeOnRestore);
  const setAutoResume = usePaneResumeStore((s) => s.setAutoResumeOnRestore);

  // OS attention-escape prefs (Plan 011). Behavioral UI prefs → prefsStore, not
  // config.toml (same reasoning as auto-resume above).
  const osNotifications = usePrefsStore((s) => s.osNotifications);
  const setOsNotifications = usePrefsStore((s) => s.setOsNotifications);
  const toastOnTurnComplete = usePrefsStore((s) => s.toastOnTurnComplete);
  const setToastOnTurnComplete = usePrefsStore((s) => s.setToastOnTurnComplete);
  useEffect(() => {
    if (!open) return;
    void claudeHooksStatus()
      .then(setHooksInstalled)
      .catch(() => setHooksInstalled(null));
  }, [open]);

  const toggleHooks = (next: boolean) => {
    if (hooksBusy) return;
    setHooksBusy(true);
    setHooksInstalled(next); // optimistic
    const op = next ? installClaudeHooks() : uninstallClaudeHooks();
    void op
      .then(() => claudeHooksStatus().then(setHooksInstalled))
      .catch((err) => {
        setHooksInstalled(!next); // revert
        useToastStore.getState().push({
          severity: "error",
          message: `Couldn't ${next ? "enable" : "disable"} Claude Code signals: ${
            err instanceof Error ? err.message : String(err)
          }`,
        });
      })
      .finally(() => setHooksBusy(false));
  };

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        close();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, close]);

  if (!mounted) return null;

  const openRawConfig = () => {
    void configFilePath().then((p) => useMdStore.getState().openMdTab(p));
    close();
  };

  return (
    <div
      className={styles.backdrop}
      data-state={state}
      onClick={close}
      role="dialog"
      aria-modal="true"
      aria-labelledby="settings-modal-title"
    >
      <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
        <div className={styles.header} id="settings-modal-title">
          Settings
          <button className={styles.closeBtn} onClick={close} aria-label="Close settings" title="Close (Esc)">
            <IconClose size={12} />
          </button>
        </div>

        <div className={styles.body}>
          <nav className={styles.rail} aria-label="Settings categories">
            {CATEGORIES.map((c) => (
              <button
                key={c.id}
                className={`${styles.railItem} ${category === c.id ? styles.railItemActive : ""}`}
                onClick={() => setCategory(c.id)}
              >
                {c.label}
              </button>
            ))}
          </nav>

          <div className={styles.content}>
            {category === "appearance" && (
              <>
                <SettingRow
                  label="Theme"
                  description="Each theme swaps the base palette and accent. The change applies live to every pane."
                  control={
                    <div className={styles.swatches}>
                      {ACCENT_PRESETS.map((p) => (
                        <button
                          key={p.id}
                          className={`${styles.swatch} ${config.theme.accent === p.id ? styles.swatchActive : ""}`}
                          style={{ background: p.color }}
                          title={p.label}
                          aria-label={p.label}
                          aria-pressed={config.theme.accent === p.id}
                          onClick={() => set("theme.accent", p.id)}
                        />
                      ))}
                    </div>
                  }
                />
                <SettingRow
                  label="Font pair"
                  description={
                    FONT_PAIRS.find((p) => p.id === config.font.pair)?.description ??
                    "Matched UI + monospace family, applied app-wide."
                  }
                  control={
                    <Dropdown ariaLabel="Font pair" value={config.font.pair}
                      options={FONT_PAIRS.map((p) => ({ value: p.id, label: p.label }))}
                      onChange={(v) => set("font.pair", v)} />
                  } />
                <SettingRow label="Font size" control={
                  <Stepper ariaLabel="Font size" value={config.font.size} min={8} max={32}
                    onChange={(v) => set("font.size", v)} />
                } />
                <SettingRow label="Font weight" control={
                  <Dropdown ariaLabel="Font weight" value={String(config.font.weight)}
                    options={[
                      { value: "300", label: "Light (300)" },
                      { value: "400", label: "Regular (400)" },
                      { value: "500", label: "Medium (500)" },
                      { value: "600", label: "Semibold (600)" },
                    ]}
                    onChange={(v) => set("font.weight", Number(v))} />
                } />
                <SettingRow label="Line height" control={
                  <Stepper ariaLabel="Line height" value={config.font.line_height} min={1.0} max={2.0} step={0.1}
                    onChange={(v) => set("font.line_height", v)} />
                } />
                <SettingRow label="Cursor shape" control={
                  <Segmented ariaLabel="Cursor shape" value={config.terminal.cursor_style}
                    options={[
                      { value: "bar", label: "Bar" },
                      { value: "block", label: "Block" },
                      { value: "underline", label: "Underline" },
                    ]}
                    onChange={(v) => set("terminal.cursor_style", v)} />
                } />
                <SettingRow label="Cursor blink" control={
                  <Toggle ariaLabel="Cursor blink" checked={config.terminal.cursor_blink}
                    onChange={(v) => set("terminal.cursor_blink", v)} />
                } />
              </>
            )}

            {category === "terminal" && (
              <>
                <SettingRow label="Default shell" description="Shell for new sessions. Running terminals are unchanged."
                  control={
                    <Dropdown ariaLabel="Default shell" value={config.default_shell}
                      options={shells.length ? shells.map((s) => ({ value: shellToConfigId(s), label: shellLabel(s) })) : [{ value: config.default_shell, label: config.default_shell }]}
                      onChange={(v) => set("default_shell", v)} />
                  } />
                <SettingRow label="Scrollback lines" control={
                  <Stepper ariaLabel="Scrollback lines" value={config.terminal.scrollback_lines} min={1000} max={100000} step={1000}
                    onChange={(v) => set("terminal.scrollback_lines", v)} />
                } />
              </>
            )}

            {category === "editor" && (
              <>
                <SettingRow label="Default mode" control={
                  <Segmented ariaLabel="Default mode" value={config.md_editor.default_mode}
                    options={[{ value: "view", label: "View" }, { value: "edit", label: "Edit" }]}
                    onChange={(v) => set("md_editor.default_mode", v)} />
                } />
                <SettingRow label="Soft wrap" control={
                  <Toggle ariaLabel="Soft wrap" checked={config.md_editor.soft_wrap}
                    onChange={(v) => set("md_editor.soft_wrap", v)} />
                } />
                <SettingRow label="Line numbers" control={
                  <Toggle ariaLabel="Line numbers" checked={config.md_editor.line_numbers}
                    onChange={(v) => set("md_editor.line_numbers", v)} />
                } />
                <SettingRow label="Trim trailing whitespace on save" control={
                  <Toggle ariaLabel="Trim trailing whitespace on save" checked={config.md_editor.trim_trailing_whitespace_on_save}
                    onChange={(v) => set("md_editor.trim_trailing_whitespace_on_save", v)} />
                } />
              </>
            )}

            {category === "sidebar" && (
              <SettingRow label="Collapsed directories" description="Folders rendered collapsed by default to skip huge trees."
                control={
                  <ChipList ariaLabel="Collapsed directories" values={config.sidebar.collapsed_dirs}
                    onChange={(v) => set("sidebar.collapsed_dirs", v)} />
                } />
            )}

            {category === "agents" && (
              <>
                <SettingRow
                  label="Precise Claude Code signals"
                  description="Install Claude Code hooks so Lume knows each agent's exact state (working, blocked on permission, turn complete) instead of guessing from output. Merges additively into ~/.claude/settings.json and can be removed here."
                  control={
                    <Toggle
                      ariaLabel="Precise Claude Code signals"
                      checked={hooksInstalled === true}
                      onChange={toggleHooks}
                    />
                  }
                />
                {hooksInstalled === true &&
                  (sawSessionStart ? (
                    <p className={styles.hint}>Active — receiving Claude Code signals.</p>
                  ) : (
                    <p className={styles.hintWarn}>
                      Hooks installed, but no Claude Code session has been detected yet. Launch{" "}
                      <code>claude</code> in a Lume terminal to confirm — if signals never appear,
                      your Claude Code version may not support hooks.
                    </p>
                  ))}
                <SettingRow
                  label="Auto-resume agents on restore"
                  description="When Lume reopens, automatically re-run the resume command for Claude and Codex panes that were running at exit. Off by default — instead a slim banner lets you resume each pane by hand."
                  control={
                    <Toggle
                      ariaLabel="Auto-resume agents on restore"
                      checked={autoResume}
                      onChange={setAutoResume}
                    />
                  }
                />
                <SettingRow
                  label="OS notifications"
                  description="Let signals leave the window when Lume is minimized or in the background: a system toast when an agent is blocked on permission, a taskbar flash, and a taskbar badge with the fleet's needs-you count. Turn off to keep every signal in-app."
                  control={
                    <Toggle
                      ariaLabel="OS notifications"
                      checked={osNotifications}
                      onChange={setOsNotifications}
                    />
                  }
                />
                <SettingRow
                  label="Toast on turn complete"
                  description="Also raise a system toast when an agent finishes its turn (your move), not just when it's blocked on permission. Off by default — turn-complete still shows the taskbar badge. Requires OS notifications on."
                  control={
                    <Toggle
                      ariaLabel="Toast on turn complete"
                      checked={toastOnTurnComplete}
                      onChange={setToastOnTurnComplete}
                    />
                  }
                />
              </>
            )}
          </div>
        </div>

        <div className={styles.footer}>
          <button className={styles.footerLink} onClick={openRawConfig}>
            Edit config.toml directly
          </button>
        </div>
      </div>
    </div>
  );
}

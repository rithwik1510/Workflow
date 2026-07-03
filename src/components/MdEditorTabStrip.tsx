// src/components/MdEditorTabStrip.tsx
import styles from "@/components/MdEditorTabStrip.module.css";
import { useMdStore } from "@/store/mdStore";

export function MdEditorTabStrip() {
  const tabs = useMdStore((s) => s.tabs);
  const activeTabId = useMdStore((s) => s.activeTabId);
  const setActiveTab = useMdStore((s) => s.setActiveTab);
  const closeMdTab = useMdStore((s) => s.closeMdTab);

  const activateRelative = (id: string, delta: number) => {
    const idx = tabs.findIndex((t) => t.id === id);
    if (idx === -1 || tabs.length === 0) return;
    const next = tabs[(idx + delta + tabs.length) % tabs.length];
    setActiveTab(next.id);
  };

  return (
    <div className={styles.strip} role="tablist" aria-label="Open files">
      {tabs.map((t) => {
        const fileName = t.path.split(/[/\\]/).pop() ?? t.path;
        const isActive = t.id === activeTabId;
        return (
          <div
            key={t.id}
            className={`${styles.tab} ${isActive ? styles.active : ""}`}
            role="tab"
            aria-selected={isActive}
            tabIndex={isActive ? 0 : -1}
            title={t.path}
            onClick={() => setActiveTab(t.id)}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                setActiveTab(t.id);
              } else if (e.key === "ArrowRight") {
                e.preventDefault();
                activateRelative(t.id, 1);
              } else if (e.key === "ArrowLeft") {
                e.preventDefault();
                activateRelative(t.id, -1);
              } else if (e.key === "Home") {
                e.preventDefault();
                if (tabs[0]) setActiveTab(tabs[0].id);
              } else if (e.key === "End") {
                e.preventDefault();
                const last = tabs[tabs.length - 1];
                if (last) setActiveTab(last.id);
              }
            }}
          >
            <span className={styles.label}>
              {t.dirty && <span className={styles.dirty} aria-hidden="true">●</span>}
              {fileName}
            </span>
            <button
              type="button"
              className={styles.close}
              title="Close tab"
              aria-label={`Close ${fileName}`}
              onClick={(e) => {
                e.stopPropagation();
                void closeMdTab(t.id);
              }}
            >
              ✕
            </button>
          </div>
        );
      })}
    </div>
  );
}

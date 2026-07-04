// src/components/ConfirmDialog.tsx
//
// Generic confirm dialog rendered from confirmStore state. Mounted once
// at App root as a sibling to other portal-style overlays. Single
// dialog at a time — the store enforces that (see confirmStore.ts).
//
// Keyboard behaviour:
//   - Esc → resolve(false)
//   - Enter → resolve(true)
//   - Backdrop click → resolve(false)
//   - Inside-dialog clicks do NOT bubble to the backdrop.
//
// Listener is attached in the capture phase so it wins over xterm's
// own keydown handler when a Terminal Pane has DOM focus underneath.

import { useEffect, useRef } from "react";
import styles from "@/components/ConfirmDialog.module.css";
import { useConfirmStore } from "@/store/confirmStore";
import { usePresence } from "@/hooks/usePresence";

export function ConfirmDialog() {
  const open = useConfirmStore((s) => s.open);
  const request = useConfirmStore((s) => s.request);
  const resolve = useConfirmStore((s) => s.resolve);

  const confirmBtnRef = useRef<HTMLButtonElement | null>(null);
  const cancelBtnRef = useRef<HTMLButtonElement | null>(null);

  // Keep the dialog mounted through its exit (scale+fade-out) animation.
  // The store clears `request` to null when it closes, so hold the last
  // non-null request to render stable content while the exit plays.
  const { mounted, state } = usePresence(open, 160);
  const lastRequest = useRef(request);
  if (request) lastRequest.current = request;

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        resolve(false);
      } else if (e.key === "Enter") {
        e.preventDefault();
        e.stopPropagation();
        resolve(true);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, resolve]);

  // Focus the appropriate button every time the dialog opens. autoFocus
  // is a one-shot mount hint and didn't re-fire on subsequent opens —
  // ref + effect is the reliable pattern.
  useEffect(() => {
    if (!open || !request) return;
    const target = request.danger ? confirmBtnRef.current : cancelBtnRef.current;
    target?.focus();
  }, [open, request]);

  const req = lastRequest.current;
  if (!mounted || !req) return null;

  const confirmLabel = req.confirmLabel ?? "Confirm";
  const cancelLabel = req.cancelLabel ?? "Cancel";
  const danger = req.danger === true;

  return (
    <div
      className={styles.backdrop}
      data-state={state}
      onClick={() => resolve(false)}
      role="dialog"
      aria-modal="true"
      aria-labelledby="confirm-dialog-title"
    >
      <div className={styles.dialog} onClick={(e) => e.stopPropagation()}>
        <div className={styles.header} id="confirm-dialog-title">
          {req.title}
        </div>
        <div className={styles.body}>{req.message}</div>
        {req.preview && <pre className={styles.preview}>{req.preview}</pre>}
        <div className={styles.footer}>
          <button
            type="button"
            className={styles.btn}
            onClick={() => resolve(false)}
            ref={cancelBtnRef}
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            className={`${styles.btn} ${danger ? styles.danger : styles.confirm}`}
            onClick={() => resolve(true)}
            ref={confirmBtnRef}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

// What just happened, over the canvas (AFD-46): a stack of info, success and error messages, each
// with a close button, read out by screen readers (errors at once, the others politely). "Saving…"
// shows in the same place, so nothing on screen moves when it comes and goes.
import { useEffect, useState } from 'react';
import { type ToastLevel, useUi } from '../store';

/** An edit that waits longer than this for the host shows "Saving…"; quicker ones show nothing. */
export const SAVING_DELAY_MS = 250;

const ICON: Record<ToastLevel, string> = { info: 'info', success: 'pass', error: 'error' };

export function Toasts() {
  const toasts = useUi((s) => s.toasts);
  const dismiss = useUi((s) => s.dismissToast);
  return (
    <div className="afd-toasts" aria-live="polite">
      <SavingNote />
      {toasts.map((t) => (
        <div
          key={t.id}
          className={`afd-toast level-${t.level}`}
          role={t.level === 'error' ? 'alert' : 'status'}
          data-toast={t.level}
        >
          <span className={`codicon codicon-${ICON[t.level]}`} aria-hidden="true" />
          <span className="afd-toast-text">{t.text}</span>
          <button
            type="button"
            className="icon"
            aria-label="Close message"
            title="Close"
            onClick={() => dismiss(t.id)}
          >
            <span className="codicon codicon-close" aria-hidden="true" />
          </button>
        </div>
      ))}
    </div>
  );
}

function SavingNote() {
  const saving = useUi((s) => s.saving);
  const [shown, setShown] = useState(false);
  useEffect(() => {
    if (!saving) {
      setShown(false);
      return;
    }
    const t = setTimeout(() => setShown(true), SAVING_DELAY_MS);
    return () => clearTimeout(t);
  }, [saving]);
  if (!shown) return null;
  return (
    <div className="afd-toast afd-saving" role="status" data-saving>
      <span className="codicon codicon-loading codicon-modifier-spin" aria-hidden="true" />
      <span className="afd-toast-text">Saving…</span>
    </div>
  );
}

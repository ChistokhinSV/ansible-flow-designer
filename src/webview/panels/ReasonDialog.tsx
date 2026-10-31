// One dialog for every decision recorded with a reason and the Git user name (AFD-35): leave a
// port open on purpose, ignore a drift item, mark a lens finding as expected. A reason is
// required; Escape closes only this dialog, so a page behind it (Properties) stays open.
import { type FormEvent, type ReactNode, useEffect, useRef, useState } from 'react';
import type { Ack } from '../bus';

export interface ReasonDialogProps {
  /** Prefix of the element ids (`<id>-title`, `<id>-reason`). */
  id: string;
  title: string;
  /** What happens when the decision is recorded. */
  children: ReactNode;
  placeholder: string;
  submit: string;
  /** The reason already recorded, when the decision exists. */
  initial?: string;
  /** Changes when the dialog opens for another target: the reason starts over. */
  target: unknown;
  record(reason: string): Promise<Ack>;
  close(): void;
}

export function ReasonDialog({
  id,
  title,
  children,
  placeholder,
  submit,
  initial,
  target,
  record,
  close,
}: ReasonDialogProps) {
  const [reason, setReason] = useState('');
  const field = useRef<HTMLTextAreaElement>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs when the dialog opens for a target; later snapshots must not reset what is being typed
  useEffect(() => {
    setReason(initial ?? '');
    setTimeout(() => field.current?.focus(), 0);
  }, [target]);

  const onSubmit = async (e?: FormEvent) => {
    e?.preventDefault();
    if (!reason.trim()) return;
    const ack = await record(reason);
    if (ack.ok) close();
  };

  return (
    <div className="afd-modal-backdrop">
      <form
        className="afd-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${id}-title`}
        onSubmit={onSubmit}
        onKeyDown={(e) => {
          if (e.key !== 'Escape') return;
          e.stopPropagation();
          close();
        }}
      >
        <h2 id={`${id}-title`}>{title}</h2>
        <p className="muted">{children}</p>
        <div className="afd-field">
          <label htmlFor={`${id}-reason`}>Reason (required)</label>
          <textarea
            id={`${id}-reason`}
            ref={field}
            className="afd-input"
            rows={3}
            value={reason}
            placeholder={placeholder}
            onChange={(e) => setReason(e.target.value)}
          />
        </div>
        <div className="afd-modal-actions">
          <button type="button" className="secondary" onClick={close}>
            Cancel
          </button>
          <button type="submit" disabled={!reason.trim()}>
            {submit}
          </button>
        </div>
      </form>
    </div>
  );
}

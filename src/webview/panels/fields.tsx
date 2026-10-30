// Inputs that commit on Enter or blur and revert on Escape, so each edit is one command (one undo
// step) instead of one per keystroke.
import { type KeyboardEvent, useEffect, useId, useRef, useState } from 'react';
import { useFocusRequest } from '../focus';
import type { FocusRequest } from '../store';

interface CommitProps {
  label: string;
  value: string;
  onCommit(value: string): void;
  multiline?: boolean;
  mono?: boolean;
  placeholder?: string;
  /** Returns an error message for invalid input; the value is not committed then. */
  validate?(value: string): string | undefined;
  /** Takes the focus (text selected) when this field is requested: F2 Rename, Edit reason. */
  focusKey?: FocusRequest['field'];
}

export function CommitField({
  label,
  value,
  onCommit,
  multiline,
  mono,
  placeholder,
  validate,
  focusKey,
}: CommitProps) {
  const id = useId();
  const ref = useRef<HTMLInputElement & HTMLTextAreaElement>(null);
  useFocusRequest(focusKey, ref);
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const error = draft !== value ? validate?.(draft) : undefined;
  const commit = () => {
    if (draft === value) return;
    if (validate?.(draft)) {
      setDraft(value);
      return;
    }
    onCommit(draft);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    if (e.key === 'Escape') {
      setDraft(value);
      (e.target as HTMLElement).blur();
    } else if (e.key === 'Enter' && (!multiline || e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      commit();
    }
  };
  const common = {
    id,
    ref,
    value: draft,
    placeholder,
    className: `afd-input${mono ? ' mono' : ''}${error ? ' invalid' : ''}`,
    onBlur: commit,
    onKeyDown,
    'aria-invalid': !!error,
  };
  return (
    <div className="afd-field">
      <label htmlFor={id}>{label}</label>
      {multiline ? (
        <textarea {...common} rows={3} onChange={(e) => setDraft(e.target.value)} />
      ) : (
        <input {...common} onChange={(e) => setDraft(e.target.value)} />
      )}
      {error ? <div className="afd-field-error">{error}</div> : null}
    </div>
  );
}

export function ReadOnly({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="afd-field">
      <span className="afd-label">{label}</span>
      <span className={`afd-readonly${mono ? ' mono' : ''}`}>{value}</span>
    </div>
  );
}

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
  /** A problem the flow check found with the stored value (AFD-44), shown under the field. */
  problem?: string;
  /** Values the browser offers as the person types (a datalist; AFD-103: Until's fields). */
  suggestions?: readonly string[];
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
  problem,
  suggestions,
}: CommitProps) {
  const id = useId();
  const ref = useRef<HTMLInputElement & HTMLTextAreaElement>(null);
  useFocusRequest(focusKey, ref);
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  // Escape blurs the field; the blur must not commit what Escape just reverted (AFD-30).
  const reverting = useRef(false);
  const error = draft !== value ? validate?.(draft) : problem;
  const commit = () => {
    if (reverting.current) {
      reverting.current = false;
      return;
    }
    if (draft === value) return;
    if (validate?.(draft)) {
      setDraft(value);
      return;
    }
    onCommit(draft);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    if (e.key === 'Escape') {
      // The field handles it: the page around it (Properties) stays open.
      e.preventDefault();
      reverting.current = true;
      setDraft(value);
      (e.target as HTMLElement).blur();
      reverting.current = false;
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
    'aria-describedby': error ? `${id}-error` : undefined,
  };
  return (
    <div className="afd-field">
      <label htmlFor={id}>{label}</label>
      {multiline ? (
        <textarea {...common} rows={3} onChange={(e) => setDraft(e.target.value)} />
      ) : (
        <input
          {...common}
          list={suggestions?.length ? `${id}-list` : undefined}
          onChange={(e) => setDraft(e.target.value)}
        />
      )}
      {suggestions?.length ? (
        <datalist id={`${id}-list`}>
          {suggestions.map((s) => (
            <option key={s} value={s} />
          ))}
        </datalist>
      ) : null}
      {error ? (
        <div className="afd-field-error" id={`${id}-error`}>
          {error}
        </div>
      ) : null}
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

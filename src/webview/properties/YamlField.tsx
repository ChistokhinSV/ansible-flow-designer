// A YAML value edited as text, committed on blur (dict params, task keywords): invalid YAML or a
// value `validate` refuses shows inline and is not committed.
import { useState } from 'react';
import { parse, stringify } from 'yaml';

export function YamlField({
  id,
  value,
  onChange,
  validate,
  rows = 3,
  placeholder,
}: {
  id: string;
  value: unknown;
  onChange(v: unknown): void;
  validate?(v: unknown): string | undefined;
  rows?: number;
  placeholder?: string;
}) {
  const text = value === undefined ? '' : stringify(value).trimEnd();
  const [draft, setDraft] = useState(text);
  const [error, setError] = useState<string>();
  return (
    <>
      <textarea
        id={id}
        className={`afd-input mono${error ? ' invalid' : ''}`}
        rows={rows}
        value={draft}
        placeholder={placeholder}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          if (!draft.trim()) {
            setError(undefined);
            onChange(undefined);
            return;
          }
          try {
            const v = parse(draft);
            const problem = validate?.(v);
            setError(problem);
            if (!problem) onChange(v);
          } catch (e) {
            setError(e instanceof Error ? e.message.split('\n')[0] : 'Not YAML');
          }
        }}
      />
      {error ? <div className="afd-field-error">{error}</div> : null}
    </>
  );
}

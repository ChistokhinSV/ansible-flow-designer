// A YAML value edited as text, committed on blur (dict params, task keywords): invalid YAML or a
// value `validate` refuses shows inline and is not committed. AFD-103 (round 3: R4): a coloured
// layer under the textarea, the wrong line marked while typing, and Enter that indents as an
// editor does. The chips of Task keywords add lines through the handle.
import {
  forwardRef,
  type KeyboardEvent,
  useEffect,
  useId,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { parse, stringify } from 'yaml';
import { enterText, yamlTokens } from '../../core/view/yamlText';

export interface YamlFieldHandle {
  /**
   * Adds a line at the end. `commit` saves at once (a complete line like `no_log: true`); else the
   * caret goes to the end of the line, or `select` characters before it are selected.
   */
  add(line: string, opts?: { commit?: boolean; select?: number }): void;
}

interface Problem {
  message: string;
  /** 1-based line of a parse error. */
  line?: number;
}

function check(text: string, validate?: (v: unknown) => string | undefined): Problem | undefined {
  if (!text.trim()) return undefined;
  try {
    const problem = validate?.(parse(text));
    return problem ? { message: problem } : undefined;
  } catch (e) {
    const line = (e as { linePos?: { line: number }[] }).linePos?.[0]?.line;
    // The parser's first line ends with a colon before the excerpt it quotes.
    const first = e instanceof Error ? (e.message.split('\n')[0] ?? '') : '';
    return { message: first.replace(/:$/, '') || 'Not YAML', line };
  }
}

export const YamlField = forwardRef<
  YamlFieldHandle,
  {
    id: string;
    value: unknown;
    onChange(v: unknown): void;
    validate?(v: unknown): string | undefined;
    rows?: number;
    placeholder?: string;
  }
>(function YamlField({ id, value, onChange, validate, rows = 3, placeholder }, ref) {
  const text = value === undefined ? '' : stringify(value).trimEnd();
  const [draft, setDraft] = useState(text);
  const [error, setError] = useState<Problem>();
  const box = useRef<HTMLTextAreaElement>(null);
  const layer = useRef<HTMLPreElement>(null);
  const caret = useRef<[number, number] | null>(null);
  const errorId = useId();
  // Callers pass `validate` inline; a ref keeps the typing check from re-running on each render.
  const rule = useRef(validate);
  rule.current = validate;

  // Checked as the person types, saved only on blur (a half-typed line is not a change).
  useEffect(() => {
    const t = setTimeout(() => setError(check(draft, rule.current)), 300);
    return () => clearTimeout(t);
  }, [draft]);

  useLayoutEffect(() => {
    if (!caret.current || !box.current) return;
    box.current.setSelectionRange(...caret.current);
    caret.current = null;
  });

  const commit = (next: string) => {
    if (!next.trim()) {
      setError(undefined);
      onChange(undefined);
      return;
    }
    const problem = check(next, validate);
    setError(problem);
    if (!problem) onChange(parse(next));
  };

  useImperativeHandle(ref, () => ({
    add(line, opts) {
      const next = draft.trimEnd() ? `${draft.trimEnd()}\n${line}` : line;
      setDraft(next);
      if (opts?.commit) {
        commit(next);
        return;
      }
      box.current?.focus();
      caret.current = [next.length - (opts?.select ?? 0), next.length];
    },
  }));

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== 'Enter' || e.shiftKey || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.nativeEvent.isComposing) return;
    const el = e.currentTarget;
    const at = el.selectionStart;
    const start = draft.lastIndexOf('\n', at - 1) + 1;
    const insert = enterText(draft.slice(start, at));
    e.preventDefault();
    const next = insert.clear
      ? draft.slice(0, start) + insert.text + draft.slice(el.selectionEnd)
      : draft.slice(0, at) + insert.text + draft.slice(el.selectionEnd);
    const pos = (insert.clear ? start : at) + insert.text.length;
    caret.current = [pos, pos];
    setDraft(next);
  };

  const lines = draft.split('\n');
  return (
    <div className="afd-yaml">
      {/* The layer covers the textarea only, not the error under it. */}
      <div className="afd-yaml-box">
        <pre ref={layer} className="afd-input mono afd-yaml-layer" aria-hidden="true">
          {lines.map((line, i) => (
            <span
              // biome-ignore lint/suspicious/noArrayIndexKey: lines are positional.
              key={i}
              className={error?.line === i + 1 ? 'afd-yaml-line error' : 'afd-yaml-line'}
            >
              {yamlTokens(line).map((t, j) =>
                t.kind ? (
                  // biome-ignore lint/suspicious/noArrayIndexKey: tokens are positional.
                  <span key={j} className={`afd-yaml-${t.kind}`}>
                    {t.text}
                  </span>
                ) : (
                  t.text
                ),
              )}
              {i < lines.length - 1 ? '\n' : ' '}
            </span>
          ))}
        </pre>
        <textarea
          ref={box}
          id={id}
          className={`afd-input mono afd-yaml-text${error ? ' invalid' : ''}`}
          rows={rows}
          value={draft}
          placeholder={placeholder}
          spellCheck={false}
          aria-invalid={!!error}
          aria-describedby={error ? errorId : undefined}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKeyDown}
          onScroll={(e) => {
            if (!layer.current) return;
            layer.current.scrollTop = e.currentTarget.scrollTop;
            layer.current.scrollLeft = e.currentTarget.scrollLeft;
          }}
          onBlur={() => commit(draft)}
        />
      </div>
      {error ? (
        <div className="afd-field-error" id={errorId}>
          {error.message}
        </div>
      ) : null}
    </div>
  );
});

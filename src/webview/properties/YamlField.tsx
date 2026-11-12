// A YAML value edited as text, committed on blur (dict params, task keywords): invalid YAML or a
// value `validate` refuses shows inline and is not committed. AFD-103 (round 3: R4): a coloured
// layer under the textarea, the wrong line marked while typing, and Enter that indents as an
// editor does. The chips of Task keywords add lines through the handle. AFD-224: Jinja inside
// values is coloured as the fields colour it, and the values of `bareKeys` as expressions. AFD-226:
// the Jinja completion list, call hint and hover help of chip fields, inside the values.
import {
  type FormEvent,
  forwardRef,
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useId,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { parse, stringify } from 'yaml';
import type { RefChoice } from '../../core/catalog/draft';
import {
  type Completion,
  type CompletionItem,
  complete,
  type Description,
  describeAt,
  type SignatureHint,
  signatureAt,
} from '../../core/view/jinjaComplete';
import type { ScanOptions } from '../../core/view/jinjaText';
import { placeMenu } from '../../core/view/menuPlace';
import {
  type ColouredText,
  enterText,
  yamlColours,
  yamlJinjaAt,
  yamlKeyContext,
} from '../../core/view/yamlText';
import {
  CompletionList,
  JinjaTip,
  listKey,
  opensList,
  pickText,
  SignatureRow,
  useJinjaContext,
} from './JinjaAssist';

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

/** The open list, with where its value is in the text and how the value reads. */
interface Assist {
  c: Completion;
  active: number;
  /** The value's text (inside its quotes) and how to scan it. */
  text: string;
  opts: ScanOptions;
  /** Where the value starts in the whole text. */
  start: number;
  /** The caret's line and column, for the marker. */
  index: number;
  col: number;
}

const NO_CHOICES: RefChoice[] = [];

/**
 * A line of the layer: coloured spans that know where they are in the text (`data-at`, for hover
 * help), and the caret marker at `markAt` when the list is open.
 */
function layerLine(
  pieces: ColouredText[],
  start: number,
  markAt: number | undefined,
  mark: ReactNode,
): ReactNode[] {
  const out: ReactNode[] = [];
  let at = 0;
  let placed = markAt === undefined;
  const piece = (text: string, colour: ColouredText['colour'], key: string, offset: number) =>
    colour ? (
      <span key={key} className={`afd-syn-${colour}`} data-at={start + offset}>
        {text}
      </span>
    ) : (
      text
    );
  pieces.forEach((t, j) => {
    const end = at + t.text.length;
    if (!placed && markAt !== undefined && markAt >= at && markAt <= end) {
      const cut = markAt - at;
      if (cut > 0) out.push(piece(t.text.slice(0, cut), t.colour, `${j}a`, at));
      out.push(mark);
      if (cut < t.text.length) out.push(piece(t.text.slice(cut), t.colour, `${j}b`, markAt));
      placed = true;
    } else out.push(piece(t.text, t.colour, String(j), at));
    at = end;
  });
  if (!placed) out.push(mark);
  return out;
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
    /** Top-level keys whose values are bare expressions (`when`): coloured as such. */
    bareKeys?: ReadonlySet<string>;
    /** What the completion list offers as variables (AFD-226). */
    choices?: RefChoice[];
    /** A chosen variable that is not an input yet: it stages one. */
    onAddInput?(choice: RefChoice): void;
  }
>(function YamlField(
  { id, value, onChange, validate, rows = 3, placeholder, bareKeys, choices, onAddInput },
  ref,
) {
  const text = value === undefined ? '' : stringify(value).trimEnd();
  const [draft, setDraft] = useState(text);
  const [error, setError] = useState<Problem>();
  const box = useRef<HTMLTextAreaElement>(null);
  const layer = useRef<HTMLPreElement>(null);
  const caret = useRef<[number, number] | null>(null);
  const errorId = useId();
  // AFD-226: the completion list (in the Jinja of the caret's value), the call hint, hover help.
  const [assist, setAssist] = useState<Assist | null>(null);
  const [hint, setHint] = useState<SignatureHint | null>(null);
  const [tip, setTip] = useState<{ d: Description; left: number; top: number } | null>(null);
  const popup = useRef<HTMLDivElement>(null);
  const marker = useRef<HTMLSpanElement>(null);
  const field = useRef<HTMLDivElement>(null);
  const hover = useRef<ReturnType<typeof setTimeout>>(undefined);
  const listId = useId();
  const ctx = useJinjaContext(choices ?? NO_CHOICES);
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

  /** The Jinja the caret is in, if any: its line, the value's text and how to read it. */
  const jinjaAt = (text: string, caretAt: number) => {
    const line = text.lastIndexOf('\n', caretAt - 1) + 1;
    const lineEnd = text.indexOf('\n', caretAt);
    const lineText = text.slice(line, lineEnd < 0 ? undefined : lineEnd);
    const index = text.slice(0, line).split('\n').length - 1;
    const keyOf = bareKeys ? yamlKeyContext(text.split('\n'))[index] : undefined;
    const j = yamlJinjaAt(lineText, caretAt - line, !!bareKeys?.has(keyOf ?? ''));
    return j ? { ...j, line, index, col: caretAt - line } : undefined;
  };

  const refreshAssist = (
    open: boolean | ((c: Completion | undefined) => boolean),
    text = draft,
  ) => {
    const el = box.current;
    if (!el || document.activeElement !== el || el.selectionStart !== el.selectionEnd) {
      setAssist(null);
      setHint(null);
      return;
    }
    const at = el.selectionStart;
    const j = jinjaAt(text, at);
    const now = new Date();
    const c = j ? complete(j.text, j.col - j.base, j.opts, { ...ctx, now }) : undefined;
    const show = typeof open === 'function' ? open(c) : open;
    setAssist((prev) =>
      j && c && c.items.length > 0 && (show || prev)
        ? {
            c,
            text: j.text,
            opts: j.opts,
            start: j.line + j.base,
            index: j.index,
            col: j.col,
            active:
              prev && prev.c.from === c.from && prev.c.context === c.context
                ? Math.min(prev.active, c.items.length - 1)
                : 0,
          }
        : null,
    );
    setHint((j && signatureAt(j.text, j.col - j.base, j.opts, { now })) ?? null);
  };

  const pickAssist = (item: CompletionItem) => {
    const el = box.current;
    if (!el || !assist) return;
    const picked = pickText(assist.text, assist.c, item, assist.opts.mode === 'template');
    // Inside a quoted YAML value a Jinja quote is written as YAML writes it: '' or \".
    const q = assist.opts.yamlQuote;
    const esc = (t: string) =>
      q === "'" ? t.replaceAll("'", "''") : q === '"' ? t.replaceAll('"', '\\"') : t;
    const text = esc(picked.text);
    const caretIn = esc(picked.text.slice(0, picked.caret)).length;
    const from = assist.start + assist.c.from;
    const to = assist.start + assist.c.to;
    el.focus();
    el.setSelectionRange(from, to);
    const next = draft.slice(0, from) + text + draft.slice(to);
    const done =
      typeof document.execCommand === 'function' && document.execCommand('insertText', false, text);
    if (!done) setDraft(next);
    el.setSelectionRange(from + caretIn, from + caretIn);
    caret.current = [from + caretIn, from + caretIn];
    if (item.choice) onAddInput?.(item.choice);
    setAssist(null);
    if (item.again) setTimeout(() => refreshAssist(true, next));
    else setHint(null);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    setTip(null);
    if (
      listKey(e, assist ? { count: assist.c.items.length, active: assist.active } : null, {
        move: (active) => setAssist((a) => (a ? { ...a, active } : a)),
        pick: () => {
          const item = assist?.c.items[assist.active];
          if (item) pickAssist(item);
        },
        close: () => setAssist(null),
        force: () => refreshAssist(true),
      })
    )
      return;
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

  // The list goes under the caret's line: a marker in the layer says where that is.
  useLayoutEffect(() => {
    const menu = popup.current;
    const at = marker.current?.getBoundingClientRect();
    if (!assist || !menu || !at || at.height === 0) return;
    // Fixed, as in chip fields: a list wider than the column does not widen or scroll it.
    const place = placeMenu(
      { left: at.left, top: at.top, bottom: at.top + 18 },
      { left: 0, top: 0 },
      { width: menu.offsetWidth, height: menu.offsetHeight },
      { width: window.innerWidth, height: window.innerHeight },
    );
    menu.style.left = `${place.left}px`;
    menu.style.top = `${place.top}px`;
  }, [assist]);

  useEffect(() => {
    if (assist)
      popup.current
        ?.querySelector('[aria-selected="true"]')
        ?.scrollIntoView?.({ block: 'nearest' });
  }, [assist]);
  useEffect(() => () => clearTimeout(hover.current), []);

  /** Help for the name under the pointer: the layer's span there says which part of the text. */
  const onHover = (x: number, y: number) => {
    clearTimeout(hover.current);
    hover.current = setTimeout(() => {
      const span = [...(layer.current?.querySelectorAll<HTMLElement>('[data-at]') ?? [])].find(
        (s) =>
          [...s.getClientRects()].some(
            (r) => x >= r.left && x <= r.right && y >= r.top && y <= r.bottom,
          ),
      );
      const at = span ? Number(span.dataset.at) : Number.NaN;
      const j = Number.isNaN(at) || assist ? undefined : jinjaAt(draft, at);
      const d = j
        ? describeAt(j.text, j.col - j.base, j.opts, { ...ctx, now: new Date() })
        : undefined;
      setTip(d ? { d, left: x, top: y + 16 } : null);
    }, 300);
  };

  const lines = draft.split('\n');
  const keys = bareKeys ? yamlKeyContext(lines) : [];
  let lineStart = 0;
  return (
    <div className="afd-yaml">
      {/* The layer covers the textarea only, not the error under it. */}
      <div className="afd-yaml-box" ref={field}>
        <pre ref={layer} className="afd-input mono afd-yaml-layer" aria-hidden="true">
          {lines.map((line, i) => {
            const at = lineStart;
            lineStart += line.length + 1;
            return (
              <span
                // biome-ignore lint/suspicious/noArrayIndexKey: lines are positional.
                key={i}
                className={error?.line === i + 1 ? 'afd-yaml-line error' : 'afd-yaml-line'}
              >
                {layerLine(
                  yamlColours(line, !!bareKeys?.has(keys[i] ?? '')),
                  at,
                  assist?.index === i ? assist.col : undefined,
                  <span ref={marker} key="caret" className="afd-yaml-caret" />,
                )}
                {i < lines.length - 1 ? '\n' : ' '}
              </span>
            );
          })}
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
          aria-autocomplete="list"
          aria-controls={assist ? listId : undefined}
          aria-activedescendant={assist ? `${listId}-${assist.active}` : undefined}
          onChange={(e) => {
            setDraft(e.target.value);
            setTip(null);
            // Typing opens the list as VS Code's suggestions open; deleting keeps an open one current.
            const native = (e as FormEvent).nativeEvent as InputEvent;
            const typed = native?.inputType?.startsWith('insert') ? native.data : null;
            const text = e.target.value;
            setTimeout(() => refreshAssist((c) => opensList(typed, c), text));
          }}
          onKeyDown={onKeyDown}
          onKeyUp={(e) => {
            if (
              ['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key) ||
              (!assist && ['ArrowUp', 'ArrowDown'].includes(e.key))
            )
              refreshAssist(false);
          }}
          onMouseUp={() => refreshAssist(false)}
          onMouseMove={(e) => onHover(e.clientX, e.clientY)}
          onMouseLeave={() => {
            clearTimeout(hover.current);
            setTip(null);
          }}
          onScroll={(e) => {
            if (!layer.current) return;
            layer.current.scrollTop = e.currentTarget.scrollTop;
            layer.current.scrollLeft = e.currentTarget.scrollLeft;
          }}
          onBlur={() => {
            setAssist(null);
            setHint(null);
            setTip(null);
            commit(draft);
          }}
        />
        {assist ? (
          <CompletionList
            ref={popup}
            id={listId}
            completion={assist.c}
            active={assist.active}
            onPick={pickAssist}
          />
        ) : null}
        {tip && !assist ? <JinjaTip tip={tip.d} style={{ left: tip.left, top: tip.top }} /> : null}
      </div>
      {hint && !assist ? <SignatureRow hint={hint} /> : null}
      {error ? (
        <div className="afd-field-error" id={errorId}>
          {error.message}
        </div>
      ) : null}
    </div>
  );
});

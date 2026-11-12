// A one-line parameter value with input chips (D-26, mockup 11): the stored text is Jinja,
// `{{ name }}` shows as a chip, typing @ (or the @ button) offers node inputs, flow inputs and
// upstream outputs. Choosing one that is not an input yet stages it as a new node input. A chip can
// read a field of a step's result, `{{ name.field }}` (AFD-108): the list offers the fields after
// a result is chosen, when `.` is typed right after its chip, and for `@name.field`. AFD-224: the
// Jinja in the text is coloured (CSS highlights, no DOM change); in `expr` mode the whole value is
// a bare expression (a condition) and there are no chips. AFD-226: inside Jinja, a completion list
// opens as you type (Ctrl+Space opens it anywhere), with help under it; the arguments of the call
// the caret is in show under the field; a name shows its help on hover.
import {
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import type { RefChoice, ResultField } from '../../core/catalog/draft';
import { segments } from '../../core/flow/jinja';
import {
  type Completion,
  type CompletionItem,
  complete,
  type Description,
  describeAt,
  type SignatureHint,
  signatureAt,
} from '../../core/view/jinjaComplete';
import { exprMode, jinjaColours, scanJinja } from '../../core/view/jinjaText';
import { placeMenu } from '../../core/view/menuPlace';
import { caretOffset, caretRect, offsetOf, pieces, replaceText, serialize } from './editableText';
import {
  CompletionList,
  JinjaTip,
  listKey,
  opensList,
  pickText,
  SignatureRow,
  useJinjaContext,
} from './JinjaAssist';
import { clearPaint, paint, paintSupported } from './syntaxPaint';

interface Props {
  id: string;
  value: string;
  onChange(value: string): void;
  choices: RefChoice[];
  /** A chosen reference that adds a node input. */
  onAddInput(choice: RefChoice): void;
  placeholder?: string;
  label?: string;
  /**
   * AFD-112: a field that saves as a whole (a Timing setting) commits on Enter and when the focus
   * leaves it, and takes back the typing on Escape, as CommitField does. The binding's parameters
   * have none: the binding saves them.
   */
  onEnter?(): void;
  onEscape?(): void;
  onLeave?(): void;
  /** `expr`: a bare expression (a condition, assert `that`): coloured as one, and no chips. */
  mode?: 'template' | 'expr';
}

type Menu =
  | { kind: 'refs'; query: string; active: number; caret: boolean }
  | {
      kind: 'fields';
      /** The result whose fields are offered. */
      of: RefChoice;
      query: string;
      active: number;
      /** The result's chip; none while `@name.` is typed, whose pick inserts it. */
      chip?: HTMLElement;
      /** Whether the person typed the dot (else the list opened when the result was chosen). */
      typed: boolean;
    };

function chip(name: string): HTMLSpanElement {
  const el = document.createElement('span');
  el.className = 'afd-ref-chip';
  el.contentEditable = 'false';
  el.dataset.ref = name;
  el.textContent = name;
  return el;
}

function render(el: HTMLElement, value: string, mode: Props['mode']): void {
  if (mode === 'expr') {
    el.replaceChildren(...(value ? [document.createTextNode(value)] : []));
    return;
  }
  el.replaceChildren(
    ...segments(value).map((s) => ('ref' in s ? chip(s.ref) : document.createTextNode(s.text))),
  );
}

/** Colours the field's text by its Jinja (AFD-224); chips keep their own look. */
function paintField(owner: object, el: HTMLElement, value: string, mode: Props['mode']): void {
  if (!paintSupported()) return;
  const list = pieces(el).filter((p) => !p.chip && p.end > p.start);
  const ranges: Parameters<typeof paint>[1] = [];
  for (const c of jinjaColours(value, { mode: exprMode(value, mode === 'expr') }))
    for (const p of list) {
      const from = Math.max(c.start, p.start);
      const to = Math.min(c.end, p.end);
      if (from >= to) continue;
      const range = document.createRange();
      range.setStart(p.node, from - p.start);
      range.setEnd(p.node, to - p.start);
      ranges.push({ colour: c.colour, range });
    }
  paint(owner, ranges);
}

/**
 * Plain text over the selection of this field (or at its end), with the caret after it. Not
 * `execCommand('insertText')`: VS Code pastes into a webview by running `execCommand('paste')` in
 * it, and Chromium refuses an execCommand from inside another, so Ctrl+V did nothing (AFD-79).
 */
function insertText(el: HTMLElement, text: string): void {
  const sel = window.getSelection();
  const range =
    sel && sel.rangeCount > 0 && el.contains(sel.getRangeAt(0).commonAncestorContainer)
      ? sel.getRangeAt(0)
      : undefined;
  const node = document.createTextNode(text);
  if (range) {
    range.deleteContents();
    range.insertNode(node);
  } else {
    el.append(node);
  }
  const caret = document.createRange();
  caret.setStartAfter(node);
  caret.collapse(true);
  sel?.removeAllRanges();
  sel?.addRange(caret);
}

/** The selection (or caret) when it is in this field. */
function selectionIn(el: HTMLElement): Range | undefined {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return undefined;
  const r = sel.getRangeAt(0);
  return el.contains(r.startContainer) && el.contains(r.endContainer) ? r.cloneRange() : undefined;
}

/** The caret right after `node`. */
function caretAfter(node: Node): void {
  const caret = document.createRange();
  caret.setStartAfter(node);
  caret.collapse(true);
  const sel = window.getSelection();
  sel?.removeAllRanges();
  sel?.addRange(caret);
}

/** The `@query` right before the caret, if the caret is in a text node of this field. */
function atQuery(el: HTMLElement): { node: Text; start: number; query: string } | undefined {
  const sel = window.getSelection();
  const node = sel?.anchorNode;
  if (!sel || !node || node.nodeType !== Node.TEXT_NODE || !el.contains(node)) return undefined;
  const before = (node.textContent ?? '').slice(0, sel.anchorOffset);
  const m = /@([A-Za-z0-9_.]*)$/.exec(before);
  return m
    ? { node: node as Text, start: before.length - m[0].length, query: m[1] ?? '' }
    : undefined;
}

/**
 * `.query` typed right after a chip, up to the caret (round 3's participant typed `.stdout` after
 * the result's chip, and it stayed text outside the braces).
 */
function dotAfterChip(
  el: HTMLElement,
): { chip: HTMLElement; node: Text; query: string } | undefined {
  const sel = window.getSelection();
  const node = sel?.anchorNode;
  if (!sel || !node || node.nodeType !== Node.TEXT_NODE || !el.contains(node)) return undefined;
  // Chromium types after a chip into a new text node, past any empty one left beside it.
  let before = node.previousSibling;
  while (before instanceof Text && !before.textContent) before = before.previousSibling;
  if (!(before instanceof HTMLElement) || !before.dataset.ref) return undefined;
  const m = /^\.([A-Za-z0-9_]*)$/.exec((node.textContent ?? '').slice(0, sel.anchorOffset));
  return m ? { chip: before, node: node as Text, query: m[1] ?? '' } : undefined;
}

/** The chip in place of the `@query` typed before the caret, with no empty text node after it. */
function replaceQuery(
  el: HTMLElement,
  at: { node: Text; start: number; query: string },
  node: Node,
) {
  const rest = at.node.splitText(at.start);
  rest.textContent = (rest.textContent ?? '').slice(1 + at.query.length);
  el.insertBefore(node, rest);
  if (!rest.textContent) rest.remove();
}

const matches = (text: string, query: string) => text.toLowerCase().includes(query.toLowerCase());

export function ChipField({
  id,
  value,
  onChange,
  choices,
  onAddInput,
  placeholder,
  label,
  onEnter,
  onEscape,
  onLeave,
  mode = 'template',
}: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const emitted = useRef<string | null>(null);
  const [menu, setMenu] = useState<Menu | null>(null);
  /**
   * Where the caret or selection was when the @ button opened the list (round 3: R5). Without it,
   * a chip from the button always went to the end of the value, even over selected text.
   */
  const opened = useRef<Range | undefined>(undefined);
  // AFD-226: the Jinja completion list, the call hint and the hover help.
  const [assist, setAssist] = useState<{ c: Completion; active: number } | null>(null);
  const [hint, setHint] = useState<SignatureHint | null>(null);
  const [tip, setTip] = useState<{ d: Description; left: number; top: number } | null>(null);
  const picking = useRef(false);
  const popup = useRef<HTMLDivElement>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const hover = useRef<ReturnType<typeof setTimeout>>(undefined);
  const listId = useId();
  const ctx = useJinjaContext(choices);
  const optsOf = (v: string) => ({ mode: exprMode(v, mode === 'expr') });

  // Re-render only for values that did not come from typing here (the caret would jump).
  useLayoutEffect(() => {
    const el = ref.current;
    if (el && value !== emitted.current) {
      render(el, value, mode);
      paintField(ref, el, value, mode);
    }
    emitted.current = value;
  }, [value, mode]);
  useEffect(() => () => clearPaint(ref), []);

  const emit = () => {
    const el = ref.current;
    if (!el) return;
    const next = serialize(el);
    emitted.current = next;
    paintField(ref, el, next, mode);
    if (next !== value) onChange(next);
  };

  const shown =
    menu?.kind === 'refs'
      ? choices.filter((c) => matches(c.name, menu.query) || matches(c.label, menu.query))
      : [];
  const fields: ResultField[] =
    menu?.kind === 'fields'
      ? (menu.of.fields ?? []).filter((f) => matches(f.name, menu.query))
      : [];
  const count = menu?.kind === 'fields' ? fields.length : shown.length;

  /** The fields list for a result: for its chip, or for `@name.` typed before a chip exists. */
  const fieldsMenu = (
    of: RefChoice,
    query: string,
    chipEl: HTMLElement | undefined,
    typed: boolean,
  ) => setMenu({ kind: 'fields', of, query, active: 0, chip: chipEl, typed });

  /**
   * Whether a chosen reference goes in as a bare name: in an expression field, or with the caret
   * inside an open `{{ ... ` (a chip there would nest braces).
   */
  const bareAt = (el: HTMLElement, at?: { node: Text; start: number }): boolean => {
    if (mode === 'expr') return true;
    const caret = at ? offsetOf(el, at.node, at.start) : caretOffset(el);
    if (caret === undefined) return false;
    const where = scanJinja(serialize(el).slice(0, caret), { mode: 'template' }).end.where;
    return where === 'expr' || where === 'stmt';
  };

  const pick = (c: RefChoice) => {
    const el = ref.current;
    if (!el) return;
    const at = menu?.kind === 'refs' && menu.caret ? atQuery(el) : undefined;
    const bare = bareAt(el, at);
    const node = bare ? document.createTextNode(c.name) : chip(c.name);
    const place =
      !at && opened.current && el.contains(opened.current.startContainer)
        ? opened.current
        : undefined;
    if (at) {
      replaceQuery(el, at, node);
    } else if (place) {
      place.deleteContents();
      place.insertNode(node);
    } else {
      el.append(node);
    }
    opened.current = undefined;
    if (c.field) onAddInput(c);
    // A whole result: its fields come next; typing on (or Esc) keeps the whole result. A bare name
    // gets them from the completion list after a `.`.
    if (c.fields && node instanceof HTMLElement) fieldsMenu(c, '', node, false);
    else setMenu(null);
    emit();
    el.focus();
    caretAfter(node);
  };

  const pickField = (f: ResultField) => {
    const el = ref.current;
    if (!el || menu?.kind !== 'fields') return;
    const name = `${menu.of.name}.${f.name}`;
    let target = menu.chip && el.contains(menu.chip) ? menu.chip : undefined;
    if (target) {
      // The `.query` typed after the chip goes into it.
      const dot = dotAfterChip(el);
      if (dot && dot.chip === target) {
        dot.node.textContent = (dot.node.textContent ?? '').slice(1 + dot.query.length);
        if (!dot.node.textContent) dot.node.remove();
      }
      target.dataset.ref = name;
      target.textContent = name;
    } else {
      // `@name.query` typed: the chip takes its place, and the input is added as for the result.
      const at = atQuery(el);
      target = bareAt(el, at)
        ? (document.createTextNode(name) as unknown as HTMLElement)
        : chip(name);
      if (at) {
        replaceQuery(el, at, target);
      } else {
        el.append(target);
      }
      if (menu.of.field) onAddInput(menu.of);
    }
    setMenu(null);
    emit();
    el.focus();
    caretAfter(target);
  };

  const pickActive = () => {
    if (!menu) return;
    if (menu.kind === 'fields') {
      const f = fields[menu.active];
      if (f) pickField(f);
    } else {
      const c = shown[menu.active];
      if (c) pick(c);
    }
  };

  useEffect(() => {
    if (menu && count > 0 && menu.active >= count) setMenu({ ...menu, active: 0 });
  }, [menu, count]);

  // A long list scrolls: keep the row the arrow keys reached in view.
  useEffect(() => {
    if (menu)
      list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView?.({ block: 'nearest' });
  }, [menu]);

  /**
   * The list for the caret: opened when `open` says so, else only kept up to date (or closed)
   * when it is open already; the call hint follows the caret either way.
   */
  const refreshAssist = (open: boolean | ((c: Completion | undefined) => boolean)) => {
    const el = ref.current;
    const caret = el ? caretOffset(el) : undefined;
    if (!el || caret === undefined) {
      setAssist(null);
      setHint(null);
      return;
    }
    const v = serialize(el);
    const c = complete(v, caret, optsOf(v), { ...ctx, now: new Date() });
    const show = typeof open === 'function' ? open(c) : open;
    setAssist((prev) =>
      c && c.items.length > 0 && (show || prev)
        ? {
            c,
            active:
              prev && prev.c.from === c.from && prev.c.context === c.context
                ? Math.min(prev.active, c.items.length - 1)
                : 0,
          }
        : null,
    );
    setHint(signatureAt(v, caret, optsOf(v), { now: new Date() }) ?? null);
  };

  const pickAssist = (item: CompletionItem) => {
    const el = ref.current;
    if (!el || !assist) return;
    const v = serialize(el);
    const { text, caret } = pickText(v, assist.c, item, optsOf(v).mode === 'template');
    picking.current = true;
    try {
      replaceText(el, assist.c.from, assist.c.to, text, caret);
    } finally {
      picking.current = false;
    }
    if (item.choice) onAddInput(item.choice);
    emit();
    el.focus();
    setAssist(null);
    refreshAssist(!!item.again);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    setTip(null);
    if (
      !menu &&
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
    if (menu && count > 0) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const step = e.key === 'ArrowDown' ? 1 : count - 1;
        setMenu({ ...menu, active: (menu.active + step) % count });
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        pickActive();
        return;
      }
    }
    if (e.key === 'Escape' && menu) {
      e.preventDefault();
      e.stopPropagation();
      setMenu(null);
      return;
    }
    if (e.key === 'Escape' && onEscape) {
      // The field handles it: the page around it stays open.
      e.preventDefault();
      e.stopPropagation();
      onEscape();
      return;
    }
    // One line: Enter does not insert a line break.
    if (e.key === 'Enter') {
      e.preventDefault();
      onEnter?.();
    }
  };

  const onInput = (e?: FormEvent<HTMLDivElement>) => {
    emit();
    // A completion going in: the pick decides what opens next.
    if (picking.current) return;
    const el = ref.current;
    if (!el) return;
    setTip(null);
    const at = atQuery(el);
    if (at) {
      setAssist(null);
      // `@read_version_result.std`: the fields of that result.
      const dot = at.query.lastIndexOf('.');
      const base = dot > 0 ? at.query.slice(0, dot) : '';
      const of = base
        ? choices.find((c) => c.fields && (c.name === base || c.label === base))
        : undefined;
      if (of) fieldsMenu(of, at.query.slice(dot + 1), undefined, true);
      else setMenu({ kind: 'refs', query: at.query, active: 0, caret: true });
      return;
    }
    const dot = dotAfterChip(el);
    const of = dot ? choices.find((c) => c.fields && c.name === dot.chip.dataset.ref) : undefined;
    if (dot && of) {
      fieldsMenu(of, dot.query, dot.chip, true);
      setAssist(null);
      return;
    }
    setMenu(null);
    // Typing opens the list as VS Code's suggestions open; deleting only keeps an open one current.
    const native = e?.nativeEvent as InputEvent | undefined;
    const typed = native?.inputType?.startsWith('insert') ? native.data : null;
    refreshAssist((c) => opensList(typed, c));
  };

  /** Where the caret moved without typing: the open list and the call hint follow it. */
  const onCaretMove = () => refreshAssist(false);

  // The list goes under the caret's line, in the window (core/view/menuPlace). It is fixed, so a
  // list wider than the panel's column neither widens nor scrolls it.
  useLayoutEffect(() => {
    const box = popup.current;
    const field = wrap.current;
    if (!assist || !box || !field) return;
    const f = field.getBoundingClientRect();
    const caret = caretRect() ?? { left: f.left, top: f.top, bottom: f.bottom };
    const at = placeMenu(
      caret,
      { left: 0, top: 0 },
      { width: box.offsetWidth, height: box.offsetHeight },
      { width: window.innerWidth, height: window.innerHeight },
    );
    box.style.left = `${at.left}px`;
    box.style.top = `${at.top}px`;
  }, [assist]);

  // A list scrolls: keep the active row in view.
  useEffect(() => {
    if (assist)
      popup.current
        ?.querySelector('[aria-selected="true"]')
        ?.scrollIntoView?.({ block: 'nearest' });
  }, [assist]);

  /** Help for the name under the pointer, after a short rest (AFD-226). */
  const onHover = (x: number, y: number) => {
    clearTimeout(hover.current);
    hover.current = setTimeout(() => {
      const el = ref.current;
      const field = wrap.current;
      const doc = document as Document & {
        caretRangeFromPoint?(x: number, y: number): Range | null;
      };
      const point = doc.caretRangeFromPoint?.(x, y);
      if (!el || !field || !point || !el.contains(point.startContainer) || assist) {
        setTip(null);
        return;
      }
      const v = serialize(el);
      const offset = offsetOf(el, point.startContainer, point.startOffset);
      const now = new Date();
      const d =
        describeAt(v, offset, optsOf(v), { ...ctx, now }) ??
        (offset > 0 ? describeAt(v, offset - 1, optsOf(v), { ...ctx, now }) : undefined);
      setTip(d ? { d, left: x, top: y + 16 } : null);
    }, 300);
  };
  useEffect(() => () => clearTimeout(hover.current), []);

  const option = (key: string, i: number, onPick: () => void, body: ReactNode) => (
    <div
      key={key}
      role="option"
      tabIndex={-1}
      aria-selected={i === menu?.active}
      className={i === menu?.active ? 'active' : ''}
      onMouseDown={(e) => {
        e.preventDefault();
        onPick();
      }}
    >
      {body}
    </div>
  );

  return (
    <div className="afd-chipfield" ref={wrap}>
      {/* biome-ignore lint/a11y/useSemanticElements: an input cannot hold chips; contenteditable can. */}
      <div
        ref={ref}
        id={id}
        className={`afd-input afd-chipfield-input${mode === 'expr' ? ' mono' : ''}`}
        contentEditable
        suppressContentEditableWarning
        role="textbox"
        tabIndex={0}
        aria-label={label}
        aria-autocomplete="list"
        spellCheck={false}
        aria-controls={assist ? listId : undefined}
        aria-activedescendant={assist ? `${listId}-${assist.active}` : undefined}
        data-placeholder={placeholder}
        onInput={onInput}
        onKeyDown={onKeyDown}
        onKeyUp={(e) => {
          if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) onCaretMove();
        }}
        onMouseUp={onCaretMove}
        onMouseMove={(e) => onHover(e.clientX, e.clientY)}
        onMouseLeave={() => {
          clearTimeout(hover.current);
          setTip(null);
        }}
        onBlur={() => {
          setTimeout(() => setMenu(null), 150);
          setAssist(null);
          setHint(null);
          setTip(null);
          onLeave?.();
        }}
        onPaste={(e) => {
          // Plain text only: pasted markup would carry its own elements.
          e.preventDefault();
          const text = e.clipboardData.getData('text/plain').replaceAll('\r', '');
          if (!text) return;
          insertText(e.currentTarget, text);
          onInput();
        }}
      />
      <button
        type="button"
        className="icon afd-chipfield-at"
        title="Insert an input (@)"
        aria-label={`Insert an input into ${label ?? 'the value'}`}
        onMouseDown={(e) => {
          // Keep the focus, and remember where in the value the chip goes.
          e.preventDefault();
          opened.current = ref.current ? selectionIn(ref.current) : undefined;
        }}
        onClick={() => setMenu(menu ? null : { kind: 'refs', query: '', active: 0, caret: false })}
      >
        @
      </button>
      {menu?.kind === 'refs' ? (
        <div ref={list} className="afd-ref-menu" role="listbox" aria-label="Inputs">
          {shown.length === 0 ? (
            <div className="muted">No inputs match. Add inputs on the Inputs and outputs tab.</div>
          ) : (
            shown.map((c, i) =>
              option(
                `${c.label}|${c.name}`,
                i,
                () => pick(c),
                <>
                  <span className="afd-ref-chip">{c.name}</span>{' '}
                  <span className="mono">{c.label !== c.name ? c.label : ''}</span>{' '}
                  <span className="muted">{c.detail}</span>
                </>,
              ),
            )
          )}
        </div>
      ) : null}
      {assist && !menu ? (
        <CompletionList
          ref={popup}
          id={listId}
          completion={assist.c}
          active={assist.active}
          onPick={pickAssist}
        />
      ) : null}
      {hint && !assist && !menu ? <SignatureRow hint={hint} /> : null}
      {tip && !assist ? <JinjaTip tip={tip.d} style={{ left: tip.left, top: tip.top }} /> : null}
      {menu?.kind === 'fields' ? (
        <div
          ref={list}
          className="afd-ref-menu"
          role="listbox"
          aria-label={`Fields of ${menu.of.name}`}
          data-ref-fields={menu.of.name}
        >
          <p className="afd-ref-menu-head muted">
            {menu.typed
              ? `Fields of ${menu.of.name}`
              : `Read one field of ${menu.of.name}, or go on typing to keep the whole result`}
          </p>
          {fields.length === 0 ? (
            <div className="muted">No documented field matches.</div>
          ) : (
            fields.map((f, i) =>
              option(
                f.name,
                i,
                () => pickField(f),
                <>
                  <span className="afd-ref-chip">{`${menu.of.name}.${f.name}`}</span>{' '}
                  <span className="muted">{f.detail}</span>
                </>,
              ),
            )
          )}
        </div>
      ) : null}
    </div>
  );
}

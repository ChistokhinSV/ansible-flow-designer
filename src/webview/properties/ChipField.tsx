// A one-line parameter value with input chips (D-26, mockup 11): the stored text is Jinja,
// `{{ name }}` shows as a chip, typing @ (or the @ button) offers node inputs, flow inputs and
// upstream outputs. Choosing one that is not an input yet stages it as a new node input. A chip can
// read a field of a step's result, `{{ name.field }}` (AFD-108): the list offers the fields after
// a result is chosen, when `.` is typed right after its chip, and for `@name.field`.
import {
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import type { RefChoice, ResultField } from '../../core/catalog/draft';
import { joinSegments, type Segment, segments } from '../../core/flow/jinja';

interface Props {
  id: string;
  value: string;
  onChange(value: string): void;
  choices: RefChoice[];
  /** A chosen reference that adds a node input. */
  onAddInput(choice: RefChoice): void;
  placeholder?: string;
  label?: string;
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

function render(el: HTMLElement, value: string): void {
  el.replaceChildren(
    ...segments(value).map((s) => ('ref' in s ? chip(s.ref) : document.createTextNode(s.text))),
  );
}

function serialize(el: HTMLElement): string {
  const parts: Segment[] = [];
  for (const n of el.childNodes) {
    if (n instanceof HTMLElement && n.dataset.ref) parts.push({ ref: n.dataset.ref, raw: '' });
    else parts.push({ text: (n.textContent ?? '').replaceAll('\n', ' ') });
  }
  return joinSegments(parts);
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

export function ChipField({ id, value, onChange, choices, onAddInput, placeholder, label }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const emitted = useRef<string | null>(null);
  const [menu, setMenu] = useState<Menu | null>(null);
  /**
   * Where the caret or selection was when the @ button opened the list (round 3: R5). Without it,
   * a chip from the button always went to the end of the value, even over selected text.
   */
  const opened = useRef<Range | undefined>(undefined);

  // Re-render only for values that did not come from typing here (the caret would jump).
  useLayoutEffect(() => {
    const el = ref.current;
    if (el && value !== emitted.current) render(el, value);
    emitted.current = value;
  }, [value]);

  const emit = () => {
    const el = ref.current;
    if (!el) return;
    const next = serialize(el);
    emitted.current = next;
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

  const pick = (c: RefChoice) => {
    const el = ref.current;
    if (!el) return;
    const at = menu?.kind === 'refs' && menu.caret ? atQuery(el) : undefined;
    const node = chip(c.name);
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
    // A whole result: its fields come next; typing on (or Esc) keeps the whole result.
    if (c.fields) fieldsMenu(c, '', node, false);
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
      target = chip(name);
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

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
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
    // One line: Enter does not insert a line break.
    if (e.key === 'Enter') e.preventDefault();
  };

  const onInput = () => {
    emit();
    const el = ref.current;
    if (!el) return;
    const at = atQuery(el);
    if (at) {
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
    if (dot && of) fieldsMenu(of, dot.query, dot.chip, true);
    else setMenu(null);
  };

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
    <div className="afd-chipfield">
      {/* biome-ignore lint/a11y/useSemanticElements: an input cannot hold chips; contenteditable can. */}
      <div
        ref={ref}
        id={id}
        className="afd-input afd-chipfield-input"
        contentEditable
        suppressContentEditableWarning
        role="textbox"
        tabIndex={0}
        aria-label={label}
        aria-autocomplete="list"
        data-placeholder={placeholder}
        onInput={onInput}
        onKeyDown={onKeyDown}
        onBlur={() => setTimeout(() => setMenu(null), 150)}
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

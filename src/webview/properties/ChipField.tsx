// A one-line parameter value with input chips (D-26, mockup 11): the stored text is Jinja,
// `{{ name }}` shows as a chip, typing @ (or the @ button) offers node inputs, flow inputs and
// upstream outputs. Choosing one that is not an input yet stages it as a new node input.
import { type KeyboardEvent, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { RefChoice } from '../../core/catalog/draft';
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

export function ChipField({ id, value, onChange, choices, onAddInput, placeholder, label }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const emitted = useRef<string | null>(null);
  const [menu, setMenu] = useState<{ query: string; active: number; caret: boolean } | null>(null);
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

  const shown = menu
    ? choices.filter(
        (c) =>
          c.name.toLowerCase().includes(menu.query.toLowerCase()) ||
          c.label.toLowerCase().includes(menu.query.toLowerCase()),
      )
    : [];

  const pick = (c: RefChoice) => {
    const el = ref.current;
    if (!el) return;
    const at = menu?.caret ? atQuery(el) : undefined;
    const node = chip(c.name);
    const place =
      !at && opened.current && el.contains(opened.current.startContainer)
        ? opened.current
        : undefined;
    if (at) {
      const rest = at.node.splitText(at.start);
      rest.textContent = (rest.textContent ?? '').slice(1 + at.query.length);
      el.insertBefore(node, rest);
    } else if (place) {
      place.deleteContents();
      place.insertNode(node);
    } else {
      el.append(node);
    }
    opened.current = undefined;
    if (c.field) onAddInput(c);
    setMenu(null);
    emit();
    el.focus();
    caretAfter(node);
  };

  useEffect(() => {
    if (menu && shown.length > 0 && menu.active >= shown.length) setMenu({ ...menu, active: 0 });
  }, [menu, shown.length]);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (menu && shown.length > 0) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const step = e.key === 'ArrowDown' ? 1 : shown.length - 1;
        setMenu({ ...menu, active: (menu.active + step) % shown.length });
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        const c = shown[menu.active];
        if (c) pick(c);
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
    const at = el ? atQuery(el) : undefined;
    setMenu(at ? { query: at.query, active: 0, caret: true } : null);
  };

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
        onClick={() => setMenu(menu ? null : { query: '', active: 0, caret: false })}
      >
        @
      </button>
      {menu ? (
        <div className="afd-ref-menu" role="listbox" aria-label="Inputs">
          {shown.length === 0 ? (
            <div className="muted">No inputs match. Add inputs on the Inputs and outputs tab.</div>
          ) : (
            shown.map((c, i) => (
              <div
                key={`${c.label}|${c.name}`}
                role="option"
                tabIndex={-1}
                aria-selected={i === menu.active}
                className={i === menu.active ? 'active' : ''}
                onMouseDown={(e) => {
                  e.preventDefault();
                  pick(c);
                }}
              >
                <span className="afd-ref-chip">{c.name}</span>
                <span className="mono">{c.label !== c.name ? c.label : ''}</span>
                <span className="muted">{c.detail}</span>
              </div>
            ))
          )}
        </div>
      ) : null}
    </div>
  );
}

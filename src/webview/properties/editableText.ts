// One model of a chip field's text (AFD-224): the stored value and where each of its characters is
// in the DOM. A chip stands for its whole `{{ name }}`; text nodes for their characters (a line
// break reads as a space); a `<br>` and an empty text node for nothing. Chromium wraps typed text in
// spans next to a chip at times: those are walked through. Colours, the caret and the completion
// list all use these offsets, so they agree with what is stored.
import { joinSegments, type Segment } from '../../core/flow/jinja';

export interface Piece {
  node: Node;
  start: number;
  end: number;
  chip?: HTMLElement;
}

const chipText = (ref: string) => `{{ ${ref} }}`;

/** The field's pieces in order, with their offsets in the stored value. */
export function pieces(el: HTMLElement): Piece[] {
  const out: Piece[] = [];
  let at = 0;
  const walk = (parent: Node) => {
    for (const n of parent.childNodes) {
      if (n instanceof HTMLElement && n.dataset.ref) {
        const len = chipText(n.dataset.ref).length;
        out.push({ node: n, start: at, end: at + len, chip: n });
        at += len;
      } else if (n.nodeType === Node.TEXT_NODE) {
        const len = (n.textContent ?? '').length;
        out.push({ node: n, start: at, end: at + len });
        at += len;
      } else if (n instanceof HTMLElement && n.tagName !== 'BR') walk(n);
    }
  };
  walk(el);
  return out;
}

/** The stored value: chips as `{{ name }}`, text as typed, line breaks as spaces. */
export function serialize(el: HTMLElement): string {
  const parts: Segment[] = pieces(el).map((p) =>
    p.chip
      ? { ref: p.chip.dataset.ref ?? '', raw: '' }
      : { text: (p.node.textContent ?? '').replaceAll('\n', ' ') },
  );
  return joinSegments(parts);
}

/** The offset of a DOM point in the stored value. */
export function offsetOf(el: HTMLElement, node: Node, offset: number, list = pieces(el)): number {
  const chip = list.find((p) => p.chip && (p.chip === node || p.chip.contains(node)));
  if (chip) return chip.end;
  if (node.nodeType === Node.TEXT_NODE) {
    const p = list.find((x) => x.node === node);
    if (p) return p.start + Math.min(offset, p.end - p.start);
  }
  // A point between children: the first piece at or after child `offset`, else the end of what
  // the node holds, else the end of what comes before it.
  const kids = [...node.childNodes];
  for (const kid of kids.slice(offset)) {
    const p = list.find((x) => x.node === kid || kid.contains(x.node));
    if (p) return p.start;
  }
  let end = 0;
  for (const p of list) {
    const pos = node.compareDocumentPosition(p.node);
    // Inside the node, or before it.
    if (node.contains(p.node) || pos & Node.DOCUMENT_POSITION_PRECEDING) end = p.end;
  }
  return end;
}

/** The caret's offset in the stored value, when the caret is in this field. */
export function caretOffset(el: HTMLElement): number | undefined {
  const sel = window.getSelection();
  const node = sel?.focusNode;
  if (!sel || !node || !el.contains(node)) return undefined;
  return offsetOf(el, node, sel.focusOffset);
}

/** The DOM point of an offset: in a text node where there is one, else beside a chip. */
export function pointAt(el: HTMLElement, offset: number, list = pieces(el)): [Node, number] {
  const text = list.find((p) => !p.chip && p.start <= offset && offset <= p.end);
  if (text) return [text.node, offset - text.start];
  const chip = list.find((p) => p.chip && p.start <= offset && offset <= p.end);
  if (chip?.chip) {
    const parent = chip.chip.parentNode as Node;
    const index = [...parent.childNodes].indexOf(chip.chip);
    return [parent, offset <= chip.start ? index : index + 1];
  }
  return [el, offset <= 0 ? 0 : el.childNodes.length];
}

export function rangeOf(el: HTMLElement, from: number, to: number): Range {
  const list = pieces(el);
  const range = document.createRange();
  range.setStart(...pointAt(el, from, list));
  range.setEnd(...pointAt(el, to, list));
  return range;
}

/** Puts the caret at an offset of the stored value. */
export function setCaret(el: HTMLElement, offset: number): void {
  const range = document.createRange();
  range.setStart(...pointAt(el, offset));
  range.collapse(true);
  const sel = window.getSelection();
  sel?.removeAllRanges();
  sel?.addRange(range);
}

/**
 * `text` in place of the stored value's `from`..`to`, with the caret after it (or `caret`
 * characters into it). Through `insertText`, so Ctrl+Z takes it back; only from a key or mouse
 * handler, never from `input` or `paste` (AFD-79). Where the browser refuses, a DOM edit.
 */
export function replaceText(
  el: HTMLElement,
  from: number,
  to: number,
  text: string,
  caret = text.length,
): void {
  const range = rangeOf(el, from, to);
  const sel = window.getSelection();
  sel?.removeAllRanges();
  sel?.addRange(range);
  const done =
    typeof document.execCommand === 'function' && document.execCommand('insertText', false, text);
  if (!done) {
    range.deleteContents();
    const node = document.createTextNode(text);
    range.insertNode(node);
    el.normalize();
  }
  setCaret(el, from + caret);
}

/** Where the caret is on screen, if the browser lays the field out (not jsdom). */
export function caretRect(): DOMRect | undefined {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return undefined;
  const r = sel.getRangeAt(0);
  if (typeof r.getBoundingClientRect !== 'function') return undefined;
  const rect = r.getBoundingClientRect();
  if (rect.height > 0) return rect;
  // A collapsed range at a node's edge can measure empty: its first line box.
  return r.getClientRects?.()[0];
}

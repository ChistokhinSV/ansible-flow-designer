// Colours for chip fields (AFD-224, ADR-0034) with the CSS Custom Highlight API: ranges of the
// field's text are named, and `::highlight(afd-syn-<colour>)` colours them. The DOM is not touched,
// so the caret, Undo, IME and the chips stay as they are. Without the API (an old engine), fields
// keep plain text; completion still works.
import type { SyntaxColour } from '../../core/view/jinjaText';

interface HighlightLike {
  add(r: AbstractRange): unknown;
  delete(r: AbstractRange): unknown;
}
interface HighlightRegistry {
  set(name: string, h: HighlightLike): unknown;
}

const registry = (): HighlightRegistry | undefined =>
  typeof CSS !== 'undefined' && 'highlights' in CSS
    ? (CSS as unknown as { highlights: HighlightRegistry }).highlights
    : undefined;
const HighlightCtor = (): (new () => HighlightLike) | undefined =>
  (globalThis as unknown as { Highlight?: new () => HighlightLike }).Highlight;

export const paintSupported = (): boolean => !!registry() && !!HighlightCtor();

const highlights = new Map<SyntaxColour, HighlightLike>();
const owned = new Map<object, { colour: SyntaxColour; range: AbstractRange }[]>();

function highlightOf(colour: SyntaxColour): HighlightLike | undefined {
  let h = highlights.get(colour);
  const Ctor = HighlightCtor();
  const reg = registry();
  if (!h && Ctor && reg) {
    h = new Ctor();
    highlights.set(colour, h);
    reg.set(`afd-syn-${colour}`, h);
  }
  return h;
}

/** The owner's ranges in their colours, in place of the ones it painted before. */
export function paint(owner: object, ranges: { colour: SyntaxColour; range: AbstractRange }[]) {
  if (!paintSupported()) return;
  clearPaint(owner);
  for (const r of ranges) highlightOf(r.colour)?.add(r.range);
  owned.set(owner, ranges);
}

export function clearPaint(owner: object): void {
  for (const r of owned.get(owner) ?? []) highlights.get(r.colour)?.delete(r.range);
  owned.delete(owner);
}

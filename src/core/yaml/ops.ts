// Byte-preserving YAML edit operations. Each op returns minimal TextEdits against `file.text`;
// text outside the edited lines (comments, quoting, blank lines) is never rewritten.
import {
  isMap,
  isScalar,
  isSeq,
  type Node,
  type Pair,
  type Scalar,
  type YAMLMap,
  type YAMLSeq,
} from 'yaml';
import type { TextEdit } from './edits';
import {
  column,
  findPair,
  hasAnchor,
  hasRefs,
  type Located,
  lineStart,
  locate,
  type Path,
  type YamlFile,
} from './parse';
import {
  Literal,
  literalLines,
  type QuoteHint,
  renderBlock,
  renderFlow,
  renderInline,
  type YamlValue,
} from './render';

export type OpResult =
  | { ok: true; edits: TextEdit[] }
  | { ok: false; code: 'not-found' | 'unsupported' | 'invalid'; reason: string };

const ok = (edits: TextEdit[]): OpResult => ({ ok: true, edits });
const fail = (code: 'not-found' | 'unsupported' | 'invalid', reason: string): OpResult => ({
  ok: false,
  code,
  reason,
});

function lineEnd(text: string, offset: number): number {
  if (offset === 0 || text[offset - 1] === '\n') return offset;
  const i = text.indexOf('\n', offset);
  return i === -1 ? text.length : i + 1;
}

function trimNewlines(text: string, start: number, end: number): number {
  let e = end;
  while (e > start && (text[e - 1] === '\n' || text[e - 1] === '\r')) e--;
  return e;
}

function afterColon(text: string, key: Node): number {
  const end = key.range?.[1] ?? 0;
  const i = text.indexOf(':', end);
  return i === -1 ? end : i + 1;
}

function isBlockCollection(node: Node | null): node is YAMLMap | YAMLSeq {
  return (isMap(node) || isSeq(node)) && !node.flow;
}

function quoteHint(node: Node | null): QuoteHint {
  return isScalar(node) ? (node.type as QuoteHint) : undefined;
}

function guardRefs(loc: Located, target: Node | null): OpResult | undefined {
  if (loc.alias || loc.ancestors.some(hasAnchor) || hasRefs(target)) {
    return fail('unsupported', 'edit touches YAML anchors or aliases');
  }
  return undefined;
}

/** Text to insert at `pos` so that `lines` become whole lines there. */
function linesAt(file: YamlFile, pos: number, lines: string[]): TextEdit {
  const { eol } = file.style;
  const body = lines.join(eol);
  const atLineStart = pos === 0 || file.text[pos - 1] === '\n';
  return { start: pos, end: pos, newText: atLineStart ? body + eol : eol + body };
}

function rerenderFlow(node: Node, value: YamlValue): OpResult {
  const range = node.range;
  if (!range) return fail('invalid', 'node has no source range');
  return ok([{ start: range[0], end: range[1], newText: renderFlow(value) }]);
}

/** Replaces the value at an existing location (map value or sequence item). */
function replaceAt(file: YamlFile, loc: Located, given: YamlValue): OpResult {
  const guard = guardRefs(loc, loc.node);
  if (guard) return guard;
  const { text, style } = file;
  const old = loc.node;
  const parent = loc.parent;
  const literalKey = !parent?.flow ? (loc.pair?.key as Node | undefined) : undefined;
  // A literal block needs a key line to hang from; elsewhere it is an ordinary string.
  const value = given instanceof Literal && !literalKey ? given.text : given;
  const literal =
    value instanceof Literal && literalKey
      ? literalLines(value.text, childColumn(file, literalKey, value))
      : undefined;
  if (literal && literalKey) {
    const at = afterColon(text, literalKey);
    const range = old?.range;
    const end =
      !range || range[0] === range[1]
        ? Math.max(at, range?.[1] ?? at)
        : trimNewlines(text, range[0], isBlockCollection(old) ? range[2] : range[1]);
    const newText = ` ${literal.indicator}${style.eol}${literal.lines.join(style.eol)}`;
    return ok([{ start: at, end, newText }]);
  }

  if (parent?.flow) {
    // Only the value's own text changes: the collection keeps its spacing, and edits of other
    // values in it (Complete IDs makes several in one batch) stay disjoint.
    if (old?.range && old.range[0] < old.range[1]) {
      const newText = renderFlow(value, quoteHint(old));
      return ok([{ start: old.range[0], end: old.range[1], newText }]);
    }
    const js = parent.toJSON() as YamlValue;
    if (Array.isArray(js)) js[parent.items.indexOf(old as never)] = value;
    else if (loc.pair)
      (js as Record<string, YamlValue>)[String((loc.pair.key as Scalar).value)] = value;
    return rerenderFlow(parent, js);
  }

  const inline = renderInline(value, quoteHint(old));
  const keyNode = loc.pair?.key as Node | undefined;

  if (!old?.range || old.range[0] === old.range[1]) {
    // Missing or empty value (`key:`): write after the colon.
    if (!keyNode) return fail('invalid', 'empty value without a key');
    const at = afterColon(text, keyNode);
    const end = old?.range ? Math.max(at, old.range[1]) : at;
    if (inline !== undefined) return ok([{ start: at, end, newText: ` ${inline}` }]);
    const col = childColumn(file, keyNode, value);
    return ok([
      { start: at, end, newText: style.eol + renderBlock(value, col, style).join(style.eol) },
    ]);
  }

  if (!isBlockCollection(old)) {
    const end = trimNewlines(text, old.range[0], old.range[1]);
    if (inline !== undefined) return ok([{ start: old.range[0], end, newText: inline }]);
    if (keyNode) {
      const col = childColumn(file, keyNode, value);
      const lines = renderBlock(value, col, style);
      return ok([
        { start: afterColon(text, keyNode), end, newText: style.eol + lines.join(style.eol) },
      ]);
    }
    const lines = renderBlock(value, column(text, old.range[0]), style, true);
    return ok([{ start: old.range[0], end, newText: lines.join(style.eol) }]);
  }

  // Old value is a block collection.
  const contentEnd = trimNewlines(text, old.range[0], old.range[2]);
  if (inline !== undefined) {
    const start = keyNode ? afterColon(text, keyNode) : old.range[0];
    return ok([{ start, end: contentEnd, newText: keyNode ? ` ${inline}` : inline }]);
  }
  // Same kind of collection: keep its indentation. Otherwise derive it from the key, since an
  // indentless sequence sits at the key's own column, where a map would not parse.
  const sameKind = isSeq(old) === Array.isArray(value);
  const col = sameKind || !keyNode ? column(text, old.range[0]) : childColumn(file, keyNode, value);
  if (keyNode) {
    const start = lineStart(text, old.range[0]);
    const lines = renderBlock(value, col, style);
    return ok([{ start, end: contentEnd, newText: lines.join(style.eol) }]);
  }
  const lines = renderBlock(value, col, style, true);
  return ok([{ start: old.range[0], end: contentEnd, newText: lines.join(style.eol) }]);
}

function childColumn(file: YamlFile, keyNode: Node, value: YamlValue): number {
  const keyCol = column(file.text, keyNode.range?.[0] ?? 0);
  return Array.isArray(value) && file.style.seqIndentless ? keyCol : keyCol + file.style.indentUnit;
}

/**
 * Sets the value at `path`. An existing value is replaced; a missing key is added to its map,
 * creating missing parent maps on the way (e.g. a first `layout:` block).
 */
export function setIn(
  file: YamlFile,
  path: Path,
  value: YamlValue,
  opts: { before?: readonly string[] } = {},
): OpResult {
  if (path.length === 0) return fail('invalid', 'empty path');
  const loc = locate(file, path);
  if (loc) return replaceAt(file, loc, value);
  const parentPath = path.slice(0, -1);
  const last = path.at(-1) as string | number;
  const parent = locate(file, parentPath);
  if (parent?.alias) return fail('unsupported', 'edit touches YAML anchors or aliases');
  if (!parent) {
    if (typeof last !== 'string')
      return fail('not-found', `no sequence at ${parentPath.join('.')}`);
    return setIn(file, parentPath, { [last]: value });
  }
  if (typeof last === 'number') return insertItem(file, parentPath, last, value);
  return insertPair(file, parent, last, value, opts.before ?? []);
}

/**
 * Writes `pair` into the text of a flow map `{...}`: before the anchor key, else after the last
 * pair. Undefined where it cannot place it (a `? key` pair or a comment in the way, or a map
 * without braces inside a sequence); the caller re-renders the map instead.
 */
function flowPairAt(
  text: string,
  map: YAMLMap,
  anchorKey: Node | undefined,
  pair: string,
): TextEdit | undefined {
  if (!map.range || text[map.range[0]] !== '{') return undefined;
  if (anchorKey?.range) {
    const at = anchorKey.range[0];
    if (!/[{,]\s*$/.test(text.slice(map.range[0], at))) return undefined;
    return { start: at, end: at, newText: `${pair}, ` };
  }
  const last = map.items.at(-1) as Pair<Node | null, Node | null> | undefined;
  const end = Math.max(last?.key?.range?.[1] ?? 0, last?.value?.range?.[1] ?? 0);
  if (!/^\s*[,}]/.test(text.slice(end, map.range[1]))) return undefined;
  return { start: end, end, newText: `, ${pair}` };
}

function insertPair(
  file: YamlFile,
  loc: Located,
  key: string,
  value: YamlValue,
  before: readonly string[],
): OpResult {
  const map = loc.node;
  if (map === null || (isScalar(map) && map.value === null))
    return replaceAt(file, loc, { [key]: value });
  if (!isMap(map)) return fail('invalid', 'parent is not a map');
  if (loc.ancestors.some(hasAnchor) || hasAnchor(map)) {
    return fail('unsupported', 'edit touches YAML anchors or aliases');
  }
  const anchor = before.map((k) => findPair(map, k)).find((p) => p !== undefined);
  const anchorKey = anchor?.key as Node | undefined;
  if (map.flow) {
    if (map.items.length === 0) return replaceAt(file, loc, { [key]: value });
    const edit = flowPairAt(file.text, map, anchorKey, `${renderFlow(key)}: ${renderFlow(value)}`);
    if (edit) return ok([edit]);
    return rerenderFlow(map, { ...(map.toJSON() as Record<string, YamlValue>), [key]: value });
  }
  const { text, style } = file;
  const first = map.items[0]?.key as Node | undefined;
  if (!first?.range || !map.range) return fail('invalid', 'map has no source range');
  const col = column(text, first.range[0]);
  const lines = renderBlock({ [key]: value }, col, style);

  if (anchorKey?.range) {
    const ls = lineStart(text, anchorKey.range[0]);
    if (text.slice(ls, anchorKey.range[0]).trim() === '') {
      return ok([{ start: ls, end: ls, newText: lines.join(style.eol) + style.eol }]);
    }
    // The anchor key shares its line with a `- ` item marker: insert after the marker.
    const pad = ' '.repeat(col);
    const body = [lines[0]?.slice(col) ?? '', ...lines.slice(1)].join(style.eol);
    return ok([
      { start: anchorKey.range[0], end: anchorKey.range[0], newText: body + style.eol + pad },
    ]);
  }
  return ok([linesAt(file, map.range[2], lines)]);
}

/**
 * Span of whole lines from `start` to `end`. At EOF without a final newline the line break before
 * the span goes with it, so that removing what `linesAt` inserted restores the bytes exactly.
 */
function wholeLines(text: string, start: number, end: number): [number, number] {
  const s = lineStart(text, start);
  const e = lineEnd(text, end);
  if (e === text.length && !text.endsWith('\n') && s > 0) {
    return [s - (text[s - 2] === '\r' ? 2 : 1), e];
  }
  return [s, e];
}

/** Span of whole lines holding a map pair. */
function pairSpan(text: string, pair: Pair<Node, Node | null>): [number, number] {
  const key = pair.key;
  const startKey = key.range?.[0] ?? 0;
  return wholeLines(text, startKey, pair.value?.range?.[2] ?? key.range?.[2] ?? startKey);
}

/** Renames a map key in place: only the key's text changes; its value and comments stay. */
export function renameKey(file: YamlFile, mapPath: Path, key: string, next: string): OpResult {
  const loc = locate(file, mapPath);
  const map = loc?.node;
  if (loc?.alias) return fail('unsupported', 'edit touches YAML anchors or aliases');
  if (!loc || !isMap(map)) return fail('not-found', `no map at ${mapPath.join('.')}`);
  const pair = findPair(map, key);
  const range = (pair?.key as Node | undefined)?.range;
  if (!pair || !range) return fail('not-found', `no key ${key}`);
  if (findPair(map, next)) return fail('invalid', `key ${next} already exists`);
  if (loc.ancestors.some(hasAnchor) || hasAnchor(map) || hasRefs(pair.key)) {
    return fail('unsupported', 'edit touches YAML anchors or aliases');
  }
  // A slash is plain in YAML: scenario files name steps inside subflows `sub/step` (AFD-115).
  const plain = /^[A-Za-z0-9][A-Za-z0-9_./-]*$/.test(next);
  return ok([{ start: range[0], end: range[1], newText: plain ? next : JSON.stringify(next) }]);
}

export function deleteKey(file: YamlFile, mapPath: Path, key: string): OpResult {
  const loc = locate(file, mapPath);
  const map = loc?.node;
  if (loc?.alias) return fail('unsupported', 'edit touches YAML anchors or aliases');
  if (!loc || !isMap(map)) return fail('not-found', `no map at ${mapPath.join('.')}`);
  const pair = findPair(map, key);
  if (!pair) return fail('not-found', `no key ${key}`);
  if (loc.ancestors.some(hasAnchor) || hasAnchor(map) || hasRefs(pair.value) || hasRefs(pair.key)) {
    return fail('unsupported', 'edit touches YAML anchors or aliases');
  }
  if (map.flow) {
    const js = map.toJSON() as Record<string, YamlValue>;
    delete js[key];
    return rerenderFlow(map, js);
  }
  const { text } = file;
  if (map.items.length === 1) {
    if (mapPath.length > 0) return replaceAt(file, loc, {});
    // Last key of the document: keep an empty map rather than an empty (null) document.
    const start = lineStart(text, map.range?.[0] ?? 0);
    const end = trimNewlines(text, start, map.range?.[2] ?? text.length);
    return ok([{ start, end, newText: '{}' }]);
  }
  const keyStart = pair.key.range?.[0] ?? 0;
  const ls = lineStart(text, keyStart);
  if (text.slice(ls, keyStart).trim() !== '') {
    // First key of a sequence item (`- key: v`): keep the marker, pull the next key up.
    const next = map.items[map.items.indexOf(pair) + 1]?.key as Node | undefined;
    if (!next?.range) return fail('invalid', 'cannot remove the only key of an item');
    return ok([{ start: keyStart, end: next.range[0], newText: '' }]);
  }
  const [start, end] = pairSpan(text, pair);
  return ok([{ start, end, newText: '' }]);
}

export function insertItem(
  file: YamlFile,
  seqPath: Path,
  index: number | 'end',
  value: YamlValue,
): OpResult {
  const loc = locate(file, seqPath);
  if (!loc) return setIn(file, seqPath, [value]);
  if (loc.alias) return fail('unsupported', 'edit touches YAML anchors or aliases');
  const seq = loc.node;
  if (seq === null || (isScalar(seq) && seq.value === null)) return replaceAt(file, loc, [value]);
  if (!isSeq(seq)) return fail('invalid', 'not a sequence');
  if (loc.ancestors.some(hasAnchor) || hasAnchor(seq)) {
    return fail('unsupported', 'edit touches YAML anchors or aliases');
  }
  const at = index === 'end' ? seq.items.length : Math.min(index, seq.items.length);
  if (seq.flow) {
    if (seq.items.length === 0) return replaceAt(file, loc, [value]);
    const js = seq.toJSON() as YamlValue[];
    js.splice(at, 0, value);
    return rerenderFlow(seq, js);
  }
  const { text, style } = file;
  if (!seq.range) return fail('invalid', 'sequence has no source range');
  const col = column(text, seq.range[0]);
  const lines = renderBlock([value], col, style);
  const next = seq.items[at] as Node | undefined;
  if (!next?.range) return ok([linesAt(file, seq.range[2], lines)]);
  const ls = lineStart(text, next.range[0]);
  const dash = ls + col;
  if (text.slice(ls, dash).trim() === '') return ok([linesAt(file, ls, lines)]);
  // The item shares its line with an outer `- ` marker (`- - a`): insert after that marker.
  const body = [lines[0]?.slice(col) ?? '', ...lines.slice(1)].join(style.eol);
  return ok([{ start: dash, end: dash, newText: body + style.eol + ' '.repeat(col) }]);
}

export function removeItem(file: YamlFile, seqPath: Path, index: number): OpResult {
  const loc = locate(file, seqPath);
  const seq = loc?.node;
  if (loc?.alias) return fail('unsupported', 'edit touches YAML anchors or aliases');
  if (!loc || !isSeq(seq)) return fail('not-found', `no sequence at ${seqPath.join('.')}`);
  const item = seq.items[index] as Node | undefined;
  if (!item?.range) return fail('not-found', `no item ${index}`);
  if (loc.ancestors.some(hasAnchor) || hasAnchor(seq) || hasRefs(item)) {
    return fail('unsupported', 'edit touches YAML anchors or aliases');
  }
  if (seq.flow) {
    const js = seq.toJSON() as YamlValue[];
    js.splice(index, 1);
    return rerenderFlow(seq, js);
  }
  if (seq.items.length === 1) return replaceAt(file, loc, []);
  const { text } = file;
  const ls = lineStart(text, item.range[0]);
  const dash = ls + column(text, seq.range?.[0] ?? ls);
  if (text.slice(ls, dash).trim() !== '') {
    // First item on an outer marker's line (`- - a`): pull the next item up to the marker.
    const next = seq.items[index + 1] as Node | undefined;
    if (!next?.range) return fail('invalid', 'cannot remove the item');
    const nextDash = lineStart(text, next.range[0]) + (dash - ls);
    return ok([{ start: dash, end: nextDash, newText: '' }]);
  }
  const [start, end] = wholeLines(text, item.range[0], item.range[2]);
  return ok([{ start, end, newText: '' }]);
}

/**
 * Several items of one sequence, as one op (AFD-160): a flow sequence (`[a, b, c]`) is rendered
 * again for each removal, so two removeItem ops in one applyAll overlapped and failed.
 */
export function removeItems(file: YamlFile, seqPath: Path, indexes: readonly number[]): OpResult {
  const wanted = [...new Set(indexes)].sort((a, b) => b - a);
  if (wanted.length <= 1)
    return wanted.length ? removeItem(file, seqPath, wanted[0] as number) : ok([]);
  const loc = locate(file, seqPath);
  const seq = loc?.node;
  if (loc && isSeq(seq) && seq.flow) {
    if (loc.alias || loc.ancestors.some(hasAnchor) || hasAnchor(seq))
      return fail('unsupported', 'edit touches YAML anchors or aliases');
    for (const i of wanted) {
      const item = seq.items[i] as Node | undefined;
      if (!item?.range) return fail('not-found', `no item ${i}`);
      if (hasRefs(item)) return fail('unsupported', 'edit touches YAML anchors or aliases');
    }
    const js = seq.toJSON() as YamlValue[];
    for (const i of wanted) js.splice(i, 1);
    return rerenderFlow(seq, js);
  }
  if (loc && isSeq(seq) && wanted.length === seq.items.length) return replaceAt(file, loc, []);
  // Block items are whole lines of their own: the removals do not touch each other.
  const edits: TextEdit[] = [];
  for (const i of wanted) {
    const one = removeItem(file, seqPath, i);
    if (!one.ok) return one;
    edits.push(...one.edits);
  }
  return ok(edits);
}

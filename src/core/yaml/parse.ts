// Parses YAML text keeping source offsets, detects the file's style, and navigates by path.
import {
  type Document,
  isAlias,
  isMap,
  isPair,
  isScalar,
  isSeq,
  type Node,
  type Pair,
  parseDocument,
  type Scalar,
  visit,
  type YAMLMap,
  type YAMLSeq,
} from 'yaml';
import type { Style } from './render';

export type Path = readonly (string | number)[];

export interface YamlError {
  message: string;
  offset: number;
}

export interface YamlFile {
  text: string;
  doc: Document.Parsed;
  style: Style;
  errors: YamlError[];
}

export function parseYaml(text: string): YamlFile {
  const doc = parseDocument(text, { keepSourceTokens: true, prettyErrors: false });
  const errors = doc.errors.map((e) => ({ message: e.message, offset: e.pos[0] }));
  return { text, doc, style: detectStyle(text, doc), errors };
}

export function lineStart(text: string, offset: number): number {
  return text.lastIndexOf('\n', offset - 1) + 1;
}

export function column(text: string, offset: number): number {
  return offset - lineStart(text, offset);
}

function detectStyle(text: string, doc: Document.Parsed): Style {
  const crlf = (text.match(/\r\n/g) ?? []).length;
  const lf = (text.match(/\n/g) ?? []).length - crlf;
  const units = new Map<number, number>();
  let indentless = 0;
  let indented = 0;
  visit(doc, {
    Pair(_, pair) {
      const key = pair.key as Node | null;
      const value = pair.value as Node | null;
      if (!key?.range || !value?.range || (!isMap(value) && !isSeq(value)) || value.flow) return;
      const keyCol = column(text, key.range[0]);
      if (isMap(value)) {
        const d = column(text, value.range[0]) - keyCol;
        if (d > 0) units.set(d, (units.get(d) ?? 0) + 1);
      } else if (column(text, value.range[0]) === keyCol) {
        indentless++;
      } else {
        indented++;
      }
    },
  });
  let unit = 2;
  let best = 0;
  for (const [d, n] of units) {
    if (n > best) {
      best = n;
      unit = d;
    }
  }
  return {
    eol: crlf > lf ? '\r\n' : '\n',
    indentUnit: unit,
    seqIndentless: indentless >= indented,
  };
}

export interface Located {
  node: Node | null;
  /** Pair holding the node when it is a map value. */
  pair?: Pair<Node, Node | null>;
  /** Collection the node belongs to. */
  parent?: YAMLMap | YAMLSeq;
  /** Every collection from the root down to the parent (anchor checks). */
  ancestors: Node[];
  /** The path ends at or runs through an alias: editing would change the anchored original. */
  alias?: boolean;
}

export function keyOf(pair: Pair): string | undefined {
  const k = pair.key as Node | null;
  return isScalar(k) ? String(k.value) : undefined;
}

export function findPair(map: YAMLMap, key: string): Pair<Node, Node | null> | undefined {
  return map.items.find((p) => keyOf(p) === key) as Pair<Node, Node | null> | undefined;
}

/** Walks a path of map keys and sequence indexes; undefined if any step is missing. */
export function locate(file: YamlFile, path: Path): Located | undefined {
  let node = file.doc.contents as Node | null;
  const ancestors: Node[] = [];
  let located: Located = { node, ancestors };
  for (const step of path) {
    if (!node) return undefined;
    if (isAlias(node)) return { node, ancestors, alias: true };
    ancestors.push(node);
    if (typeof step === 'number') {
      if (!isSeq(node)) return undefined;
      const item = node.items[step] as Node | undefined;
      if (item === undefined) return undefined;
      located = { node: item, parent: node, ancestors: [...ancestors] };
      node = item;
    } else {
      if (!isMap(node)) return undefined;
      const pair = findPair(node, step);
      if (!pair) return undefined;
      located = { node: pair.value, pair, parent: node, ancestors: [...ancestors] };
      node = pair.value;
    }
  }
  if (isAlias(located.node)) located.alias = true;
  return located;
}

export function hasAnchor(node: Node | null | undefined): boolean {
  return !!node && 'anchor' in node && !!(node as Scalar).anchor;
}

/** True if the subtree defines anchors or uses aliases: editing it would change other places. */
export function hasRefs(node: Node | null | undefined): boolean {
  if (!node) return false;
  let found = false;
  visit(node, {
    Node(_, n) {
      if (isAlias(n) || hasAnchor(n)) {
        found = true;
        return visit.BREAK;
      }
    },
  });
  return found;
}

export { isMap, isPair, isScalar, isSeq };

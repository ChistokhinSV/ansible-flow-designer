// Flow text → parsed YAML + plain data, and YAML paths → source ranges for diagnostics.
import { isMap, isSeq, type Node } from 'yaml';
import { locate, type Path, parseYaml, type YamlError, type YamlFile } from '../yaml/parse';
import type { FlowDocument } from './types';

export interface ParsedFlow {
  file: YamlFile;
  /** Plain data; undefined when the YAML has errors or is not a mapping. */
  doc?: FlowDocument;
  errors: YamlError[];
}

export function parseFlow(text: string): ParsedFlow {
  return flowFromFile(parseYaml(text));
}

/**
 * Whether plain data contains itself (AFD-147). yaml builds a circular object for an alias inside
 * the node it names (`subflow: &s {nodes: [{subflow: *s}]}`), and every walker of the model, the
 * paste and Complete IDs would then recurse until the stack ran out.
 */
export function containsItself(value: unknown): boolean {
  const ancestors = new Set<object>();
  const walk = (v: unknown): boolean => {
    if (!v || typeof v !== 'object') return false;
    if (ancestors.has(v)) return true;
    ancestors.add(v);
    const found = (Array.isArray(v) ? v : Object.values(v)).some(walk);
    ancestors.delete(v);
    return found;
  };
  return walk(value);
}

export const SELF_ALIAS =
  'A YAML alias here names something that contains it, so the flow would never end: write the part out instead';

/** Same as parseFlow for text that is already parsed (e.g. the result of a command). */
export function flowFromFile(file: YamlFile): ParsedFlow {
  if (file.errors.length > 0) return { file, errors: file.errors };
  const data = file.doc.toJS({ maxAliasCount: 100 });
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    return { file, errors: [{ message: 'A flow document must be a YAML mapping', offset: 0 }] };
  }
  if (containsItself(data)) return { file, errors: [{ message: SELF_ALIAS, offset: 0 }] };
  return { file, doc: data as FlowDocument, errors: [] };
}

/**
 * The whole element at a path, in full lines: "Show in text" selects a node with everything in
 * it (AFD-18 follow-up), from the line of its `- ` to its last value, without trailing comments.
 * Falls back to the finding range when the path does not lead to a node.
 */
export function elementRangeOf(file: YamlFile, path: Path): [number, number] {
  const node = locate(file, path)?.node as Node | null | undefined;
  if (!node?.range) return rangeOf(file, path);
  const text = file.text;
  let end = node.range[1];
  while (end > node.range[0] && /\s/.test(text[end - 1] ?? '')) end--;
  return [text.lastIndexOf('\n', node.range[0] - 1) + 1, end];
}

/**
 * Source range for a finding: the deepest existing node on the path. Collections are narrowed to
 * their first line, so a diagnostic on a node does not underline the whole node.
 */
export function rangeOf(file: YamlFile, path: Path): [number, number] {
  for (let n = path.length; n >= 0; n--) {
    const loc = locate(file, path.slice(0, n));
    const node = (loc?.node ?? (n > 0 ? loc?.pair?.key : null)) as Node | null | undefined;
    const keyNode = loc?.pair?.key as Node | undefined;
    const target = node?.range ? node : keyNode;
    if (!target?.range) continue;
    const [start, end] = target.range;
    if (isMap(target) || isSeq(target)) {
      const nl = file.text.indexOf('\n', start);
      return [start, nl === -1 || nl > end ? end : nl];
    }
    return [start, end];
  }
  return [0, 0];
}

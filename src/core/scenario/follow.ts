// Scenarios follow the flow (AFD-115): a step or end renamed, moved into a subflow (extract), or a
// subflow renamed changes the key paths a scenarios file names it by. Matched by node ID before
// and after the flow edit, the file's `force` and `approvals` keys and its `expect` values are
// rewritten in the same edit, byte-preserving. A path whose node is gone stays: the check names it.
import type { FlowDocument, Ulid } from '../flow/types';
import type { TextEdit } from '../yaml/edits';
import { renameKey, setIn } from '../yaml/ops';
import { YamlTransaction } from '../yaml/transaction';
import { byPath, type ScenarioFile } from './scenarios';

export interface PathChanges {
  /** Old key path → new key path, for nodes that are still there. */
  moved: Map<string, string>;
  /** Key paths of nodes the edit removed. */
  gone: Set<string>;
}

const idPaths = (doc: FlowDocument) => {
  const out = new Map<Ulid, string>();
  for (const [path, node] of byPath(doc)) if (node.id) out.set(node.id, path);
  return out;
};

/** How the key paths of a flow's nodes changed between two versions of it. */
export function pathChanges(before: FlowDocument, after: FlowDocument): PathChanges {
  const was = idPaths(before);
  const now = idPaths(after);
  const moved = new Map<string, string>();
  const gone = new Set<string>();
  for (const [id, path] of was) {
    const next = now.get(id);
    if (next === undefined) gone.add(path);
    else if (next !== path) moved.set(path, next);
  }
  return { moved, gone };
}

/** A `<step>.<port>` or end path, with its path part moved. */
function movedTarget(where: string, moved: Map<string, string>): string | undefined {
  const whole = moved.get(where);
  if (whole) return whole;
  const dot = where.lastIndexOf('.');
  const step = dot > 0 ? moved.get(where.slice(0, dot)) : undefined;
  return step ? `${step}${where.slice(dot)}` : undefined;
}

export interface FollowResult {
  text: string;
  edits: TextEdit[];
  /** What was rewritten, in words, for the edit's note. */
  notes: string[];
}

/**
 * The scenarios text with the moved key paths rewritten; undefined when nothing names them, or
 * when the file does not parse (the edit then leaves it alone, and the check reports it).
 */
export function followPaths(text: string, changes: PathChanges): FollowResult | undefined {
  if (changes.moved.size === 0) return undefined;
  let tx: YamlTransaction;
  try {
    tx = new YamlTransaction(text);
  } catch {
    return undefined;
  }
  const file = tx.current.doc.toJS() as ScenarioFile | null;
  const scenarios = Array.isArray(file?.scenarios) ? file.scenarios : [];
  const notes = new Set<string>();
  scenarios.forEach((s, i) => {
    if (!s || typeof s !== 'object') return;
    for (const field of ['force', 'approvals'] as const) {
      const map = s[field];
      if (!map || typeof map !== 'object') continue;
      const keys = Object.keys(map);
      for (const key of keys) {
        const next = changes.moved.get(key);
        // A key already there (two scenarios' steps swapped) is left for the check to name.
        if (!next || keys.includes(next)) continue;
        tx.apply((f) => renameKey(f, ['scenarios', i, field], key, next));
        notes.add(`${key} → ${next}`);
      }
    }
    for (const [host, where] of Object.entries(s.expect ?? {})) {
      if (typeof where !== 'string') continue;
      const next = movedTarget(where, changes.moved);
      if (!next) continue;
      tx.apply((f) => setIn(f, ['scenarios', i, 'expect', host], next));
      notes.add(`${where} → ${next}`);
    }
  });
  if (notes.size === 0) return undefined;
  return { text: tx.text, edits: tx.edits(), notes: [...notes] };
}

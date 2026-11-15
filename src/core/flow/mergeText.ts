// AFD-283: a merged flow written over "ours" text with the fewest edits, so its comments, quoting
// and order stay where they were and the file's diff shows only what the merge brought in. Lists
// of things with IDs (steps, wires, notes) are matched by ID; anything else changed is replaced.

import { deleteKey, insertItem, removeItem, setIn } from '../yaml/ops';
import { type Path, parseYaml } from '../yaml/parse';
import type { YamlValue } from '../yaml/render';
import { YamlTransaction } from '../yaml/transaction';
import { canonical } from './semantic';
import type { FlowDocument } from './types';

const same = (a: unknown, b: unknown) =>
  JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const idOf = (v: unknown) => (isRecord(v) && typeof v.id === 'string' ? v.id : undefined);
const byId = (list: unknown[]) => list.length > 0 && list.every((v) => idOf(v) !== undefined);

/** `text` (ours) rewritten to say `doc`. */
export function writeMergedFlow(text: string, doc: FlowDocument): string {
  const tx = new YamlTransaction(text);
  const current = parseYaml(text).doc.toJS() as unknown;
  sync(tx, [], current, doc);
  return tx.text;
}

function sync(tx: YamlTransaction, path: Path, was: unknown, now: unknown): void {
  if (same(was, now)) return;
  if (isRecord(was) && isRecord(now)) {
    for (const key of Object.keys(was))
      if (!(key in now) || now[key] === undefined) tx.apply((f) => deleteKey(f, path, key));
    for (const [key, value] of Object.entries(now)) {
      if (value === undefined) continue;
      if (key in was) sync(tx, [...path, key], was[key], value);
      else tx.apply((f) => setIn(f, [...path, key], value as YamlValue));
    }
    return;
  }
  if (Array.isArray(was) && Array.isArray(now) && byId(was) && byId(now)) {
    const wanted = new Set(now.map(idOf));
    // Removals first, from the end, so the earlier indexes hold.
    const list = [...was];
    for (let i = list.length - 1; i >= 0; i--)
      if (!wanted.has(idOf(list[i]))) {
        tx.apply((f) => removeItem(f, path, i));
        list.splice(i, 1);
      }
    now.forEach((item, i) => {
      const at = list.findIndex((x) => idOf(x) === idOf(item));
      if (at >= 0) {
        sync(tx, [...path, at], list[at], item);
        return;
      }
      const index = Math.min(i, list.length);
      tx.apply((f) =>
        insertItem(f, path, index === list.length ? 'end' : index, item as YamlValue),
      );
      list.splice(index, 0, item);
    });
    return;
  }
  tx.apply((f) => setIn(f, path, now as YamlValue));
}

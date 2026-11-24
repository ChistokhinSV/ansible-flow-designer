// AFD-378: a flow copied as a file (Explorer copy, a duplicate in Git) keeps its flow ID and every
// node and wire ID. The designer keeps pause points, remembered inputs and run history by the
// flow's ID, and Code mode matches playbooks by node ID, so the copy and the original mixed. A
// copy gets new IDs in one edit: every ID the file holds is replaced wherever it is written
// (layout keys, wires, boundaries, decisions, notes), so nothing is left pointing at the old ones.

import { applyEdits } from '../yaml/edits';
import { setIn } from '../yaml/ops';
import { YamlTransaction } from '../yaml/transaction';
import { parseFlow } from './document';
import { type IdFactory, slugify } from './ids';
import type { FlowNode, Ulid } from './types';

interface Level {
  nodes?: (FlowNode | null)[];
  edges?: ({ id?: Ulid } | null)[];
  annotations?: ({ id?: Ulid } | null)[];
}

function idsOf(level: Level, out: Set<string>): void {
  for (const n of level.nodes ?? []) {
    if (!n) continue;
    if (typeof n.id === 'string') out.add(n.id);
    if (n.subflow) idsOf(n.subflow as Level, out);
  }
  for (const e of level.edges ?? []) if (typeof e?.id === 'string') out.add(e.id);
  for (const a of level.annotations ?? []) if (typeof a?.id === 'string') out.add(a.id);
}

/**
 * The flow's text with a new ID for the flow and for every node, wire and note, and with `key` as
 * its key when given (a copy beside the original would write the same generated playbooks);
 * undefined when it does not parse.
 */
export function withNewIds(text: string, newId: IdFactory, key?: string): string | undefined {
  const parsed = parseFlow(text);
  const doc = parsed.doc;
  if (!doc) return undefined;
  const ids = new Set<string>();
  if (typeof doc.flow.id === 'string') ids.add(doc.flow.id);
  idsOf(doc as Level, ids);
  let out = text;
  if (key && key !== doc.flow.key) {
    const tx = new YamlTransaction(text, parsed.file);
    tx.apply((f) => setIn(f, ['flow', 'key'], key));
    out = applyEdits(text, tx.edits());
  }
  // IDs are ULIDs: 26 characters that occur nowhere else, so plain replacement is exact.
  for (const old of ids) if (old.length >= 10) out = out.split(old).join(newId());
  return out;
}

/** A key for a copy from its file name (`c9-hello.flow.yaml` is `c9-hello`). */
export function keyFromFile(name: string): string {
  return slugify(name.replace(/\.flow\.ya?ml$/i, ''), 'flow');
}

/** Flows that share a flow ID, by ID: only IDs held by more than one file. */
export function sharedIds<T extends { id?: string | undefined }>(
  flows: readonly T[],
): Map<string, T[]> {
  const by = new Map<string, T[]>();
  for (const f of flows) if (f.id) by.set(f.id, [...(by.get(f.id) ?? []), f]);
  for (const [id, list] of by) if (list.length < 2) by.delete(id);
  return by;
}

/** One file of a group that shares a flow ID: whether Git tracks it and when it was made. */
export interface CopyCandidate {
  /** Undefined outside a Git repository. */
  tracked?: boolean | undefined;
  /** Creation time (ms) where the file system keeps one, else its last change; 0 if unknown. */
  born: number;
}

/**
 * AFD-380: which files of a group sharing a flow ID are the copies, so that only they are flagged
 * and offered new IDs: the original keeps its IDs (Code mode, history, scenarios and server links
 * follow them). Git decides first: tracked files are originals when some are not. Otherwise the
 * oldest file is the original. When neither tells them apart, every file is flagged.
 */
export function copiesAmong<T extends CopyCandidate>(group: readonly T[]): T[] {
  const tracked = group.filter((f) => f.tracked === true);
  if (tracked.length > 0 && tracked.length < group.length)
    return group.filter((f) => f.tracked !== true);
  const pool = tracked.length > 0 ? tracked : group;
  const known = pool.filter((f) => f.born > 0);
  if (known.length < pool.length || known.length < 2) return [...group];
  const first = Math.min(...known.map((f) => f.born));
  const originals = known.filter((f) => f.born === first);
  if (originals.length > 1) return [...group];
  return group.filter((f) => f !== originals[0]);
}

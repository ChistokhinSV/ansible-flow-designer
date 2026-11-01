// Re-import (AFD-61): a flow imported as is from playbooks takes the source's later changes without
// losing the designer's. Each imported step records where it came from and what it looked like
// (`origin: {task, design}`); a fresh import of the changed source is merged step by step:
//   the source changed and the designer did not: the step takes the source's version;
//   both changed: a conflict, the designer's version stays unless the user takes the source's;
//   only the designer changed it: it stays;
// a new task becomes a step after the step of the task before it, and a step whose task is gone is
// flagged, not deleted (product-owner decision).
import { modelOf } from '../flow/model';
import { canonical } from '../flow/semantic';
import type { FlowDocument, FlowNode, Ulid } from '../flow/types';

/** The fields an import writes and a re-import may replace. */
export const IMPORTED_FIELDS = ['title', 'intent', 'impl', 'settings', 'ports'] as const;

/** FNV-1a of a step's imported fields: what tells the source's version from the designer's. */
export function stepDesign(node: FlowNode): string {
  const text = JSON.stringify(
    canonical(Object.fromEntries(IMPORTED_FIELDS.map((k) => [k, node[k]]))),
  );
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

export interface ReimportUpdate {
  node: Ulid;
  key: string;
  /** The source's version of the imported fields, and its fingerprint. */
  fields: Partial<Pick<FlowNode, (typeof IMPORTED_FIELDS)[number]>>;
  design: string;
  /** Which fields differ from the step now. */
  changed: string[];
}

export interface ReimportAdd {
  /** The new step, as the fresh import made it (its ID is new in this flow too). */
  step: FlowNode;
  /** The step of the task before it, which the new step follows on its ok_hosts wire. */
  after?: Ulid;
}

export interface ReimportPlan {
  /** Source changed, designer did not: applied. */
  updates: ReimportUpdate[];
  /** Both changed: the designer's stays unless chosen. */
  conflicts: ReimportUpdate[];
  adds: ReimportAdd[];
  /** Steps whose source task is gone: flagged. */
  gone: { node: Ulid; key: string }[];
  /** Steps the source did not change. */
  same: number;
}

/** Imported steps by source task, in traversal order. */
function byTask(doc: FlowDocument): Map<string, FlowNode> {
  const out = new Map<string, FlowNode>();
  for (const { node } of modelOf(doc).nodes.values())
    if (node.origin?.task && !out.has(node.origin.task)) out.set(node.origin.task, node);
  return out;
}

export function planReimport(current: FlowDocument, fresh: FlowDocument): ReimportPlan {
  const mine = byTask(current);
  const theirs = byTask(fresh);
  const plan: ReimportPlan = { updates: [], conflicts: [], adds: [], gone: [], same: 0 };
  let previous: Ulid | undefined;
  for (const [task, f] of theirs) {
    const c = mine.get(task);
    if (!c) {
      plan.adds.push({ step: f, ...(previous ? { after: previous } : {}) });
      continue;
    }
    previous = c.id;
    const was = c.origin?.design;
    const sourceChanged = f.origin?.design !== was;
    if (!sourceChanged) {
      plan.same++;
      continue;
    }
    const designerChanged = stepDesign(c) !== was;
    const fields = Object.fromEntries(IMPORTED_FIELDS.map((k) => [k, f[k]]));
    const changed = IMPORTED_FIELDS.filter(
      (k) => JSON.stringify(canonical(c[k])) !== JSON.stringify(canonical(f[k])),
    );
    const update = { node: c.id, key: c.key, fields, design: f.origin?.design ?? '', changed };
    if (changed.length === 0) plan.same++;
    else (designerChanged ? plan.conflicts : plan.updates).push(update);
  }
  for (const [task, c] of mine)
    if (!theirs.has(task) && !c.origin?.gone) plan.gone.push({ node: c.id, key: c.key });
  return plan;
}

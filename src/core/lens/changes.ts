// Changes lens (AFD-57): the flow against another version of it (HEAD, a branch, a commit), node
// by node, for a review. Added and changed nodes get chips, a subflow says how many changes are
// inside it, removed nodes come back as ghosts where they stood, and the panel lists everything.
import { modelOf } from '../flow/model';
import { changesInside, diffFlows, type FieldChange } from '../flow/semanticDiff';
import type { FlowDocument } from '../flow/types';
import type { CompareFacts, LensChip, LensItem, LensView } from './types';

const FIELD_LABEL: Record<string, string> = {
  impl: 'binding',
  settings: 'settings',
  inputs: 'inputs',
  outputs: 'outputs',
  accepted: 'accepted',
  boundary: 'boundary',
};

export const fieldLabel = (f: FieldChange) => FIELD_LABEL[f.field] ?? f.field;

const plural = (n: number, what: string) => `${n} ${what}${n === 1 ? '' : 's'}`;

export function changesLens(doc: FlowDocument, compare: CompareFacts | undefined): LensView {
  const view: LensView = {
    lens: 'changes',
    chips: {},
    stats: [],
    sections: [],
    findings: [],
    notes: [],
  };
  if (!compare) {
    view.notes.push('Reading the versions of this flow from Git…');
    return view;
  }
  view.stats.push({ label: 'Compared with', value: compare.label });
  if (compare.state !== 'ready' || !compare.base) {
    view.notes.push(
      compare.state === 'loading'
        ? `Reading ${compare.label}…`
        : (compare.error ?? `${compare.label} has no version of this flow`),
    );
    return view;
  }
  const diff = diffFlows(compare.base, doc);
  const model = modelOf(doc);
  const where = (w: string[]) => (w.length ? w.join(' › ') : 'top level');
  const changed: LensItem[] = [];
  const added: LensItem[] = [];
  const removed: LensItem[] = [];
  for (const n of diff.nodes) {
    if (n.kind === 'changed') {
      const fields = n.fields.map(fieldLabel);
      view.chips[n.id] = [{ text: `changed: ${fields.join(', ')}`, title: fields.join(', ') }];
      changed.push({
        key: n.id,
        label: n.title,
        value: fields.join(', '),
        detail: where(n.where),
        nodes: [n.id],
      });
    } else if (n.kind === 'added') {
      view.chips[n.id] = [{ text: 'added' }];
      added.push({ key: n.id, label: n.title, detail: where(n.where), nodes: [n.id] });
    } else {
      removed.push({
        key: n.id,
        label: n.title,
        detail: `was on ${where(n.where)}`,
        nodes: [],
        tone: 'muted',
      });
    }
  }
  // A subflow says how much changed inside it, so a review knows where to go in.
  for (const { node } of model.nodes.values()) {
    if (node.type !== 'subflow') continue;
    const inside = changesInside(diff, model, node.id);
    if (inside === 0) continue;
    const chip: LensChip = { text: `${plural(inside, 'change')} inside` };
    view.chips[node.id] = [...(view.chips[node.id] ?? []), chip].slice(0, 2);
  }
  view.ghosts = diff.nodes
    .filter((n) => n.kind === 'removed')
    .map((n) => ({ id: n.id, title: n.title, type: n.type, level: n.level, position: n.position }));
  view.wires = Object.fromEntries(
    diff.wires.filter((w) => w.kind === 'added' && w.edge).map((w) => [w.edge, 'added']),
  );
  const wireItems = diff.wires.map((w) => ({
    key: `${w.kind}:${w.label}`,
    label: `${w.kind === 'added' ? '+' : '−'} ${w.label}`,
    nodes: w.kind === 'added' ? [w.from.node, w.to.node].filter((id) => model.nodes.has(id)) : [],
    tone: w.kind === 'removed' ? ('muted' as const) : undefined,
  }));
  const flowItems = diff.flow.map((f) => ({ key: f.field, label: f.field, nodes: [] }));
  view.stats.push(
    { label: 'Changed', value: String(changed.length) },
    { label: 'Added', value: String(added.length) },
    { label: 'Removed', value: String(removed.length) },
    {
      label: 'Wires',
      value: `+${diff.wires.filter((w) => w.kind === 'added').length} −${diff.wires.filter((w) => w.kind === 'removed').length}`,
    },
  );
  view.sections.push(
    { title: 'Changed', items: changed, empty: 'No node changed' },
    { title: 'Added', items: added, empty: 'No node added' },
    { title: 'Removed', items: removed, empty: 'No node removed' },
    { title: 'Wires', items: wireItems, empty: 'No wire added or removed' },
    { title: 'Flow', items: flowItems, empty: 'Name, goal, inputs and runtime unchanged' },
  );
  if (diff.nodes.length + diff.wires.length + diff.flow.length === 0)
    view.notes.push(`No changes since ${compare.label}`);
  return view;
}

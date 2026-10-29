// Data lens (04 §7, decision 14): what each node reads and writes, and the data wires derived from
// `from:` references. A reference into another level is drawn from the producer to the subflow
// that contains the consumer, on the producer's level.
import { buildModel, keyScope, ROOT } from '../flow/model';
import type { FlowDocument, Ulid } from '../flow/types';
import { isWork, listChip, title, visibleAt } from './common';
import type { DataWire, LensChip, LensFinding, LensItem, LensView } from './types';

export function dataLens(doc: FlowDocument): LensView {
  const model = buildModel(doc);
  const flowInputs = doc.flow.inputs ?? {};
  const start = model.levels.get(ROOT)?.nodes.find((n) => n?.type === 'start')?.id;
  const chips: Record<Ulid, LensChip[]> = {};
  const wires = new Map<string, DataWire>();
  const findings: LensFinding[] = [];
  /** `key.output` → consumers. */
  const readers = new Map<string, Set<Ulid>>();
  const inputUse = new Map<string, Set<Ulid>>();

  const wire = (from: Ulid, to: Ulid, label: string, text: string) => {
    if (from === to) return;
    const id = `data:${from}>${to}`;
    const w = wires.get(id);
    if (!w) wires.set(id, { id, from, to, label, title: text });
    else if (!w.label.split(', ').includes(label)) {
      w.label = `${w.label}, ${label}`;
      w.title = `${w.title}\n${text}`;
    }
  };

  for (const { node, level } of model.nodes.values()) {
    if (!isWork(node)) continue;
    const scope = keyScope(model, level);
    const ins = Object.keys(node.inputs ?? {});
    const outs = Object.keys(node.outputs ?? {});
    chips[node.id] = [listChip('in: ', ins), listChip('out: ', outs)].filter(
      (c): c is LensChip => !!c,
    );
    for (const [name, field] of Object.entries(node.inputs ?? {})) {
      const from = field?.from;
      if (!from) {
        if (field?.required && field.default === undefined)
          findings.push({
            id: `data:unresolved:${node.id}.${name}`,
            lens: 'data',
            severity: 'warning',
            title: `${node.title} has no value for ${name}`,
            detail: `The input ${name} is required, has no default and no \`from:\`. Wire it to a flow input or an upstream output.`,
            node: node.id,
            nodes: [node.id],
            fixes: [{ label: 'Open properties', properties: node.id }],
          });
        continue;
      }
      const [head = '', ...rest] = from.split('.');
      const out = rest[0] ?? '';
      if (head === 'impl') continue;
      if (head === 'flow') {
        if (!(out in flowInputs)) {
          findings.push(unresolved(node.id, node.title, name, from));
          continue;
        }
        inputUse.set(out, (inputUse.get(out) ?? new Set()).add(node.id));
        const to = start ? visibleAt(model, node.id, ROOT) : undefined;
        if (start && to) wire(start, to, out, `flow.${out} → ${node.title}.${name}`);
        continue;
      }
      const producer = scope.get(head);
      const p = producer ? model.nodes.get(producer) : undefined;
      if (!producer || !p || (out && !(out in (p.node.outputs ?? {})))) {
        findings.push(unresolved(node.id, node.title, name, from));
        continue;
      }
      const key = `${head}.${out}`;
      readers.set(key, (readers.get(key) ?? new Set()).add(node.id));
      const to = visibleAt(model, node.id, p.level);
      if (to)
        wire(
          producer,
          to,
          out === name ? out : `${out} → ${name}`,
          `${from} → ${node.title}.${name}`,
        );
    }
  }

  const variables: LensItem[] = [];
  for (const { node } of model.nodes.values()) {
    for (const out of Object.keys(node.outputs ?? {})) {
      const users = [...(readers.get(`${node.key}.${out}`) ?? [])];
      variables.push({
        key: `var:${node.id}.${out}`,
        label: `${node.key}.${out}`,
        detail: users.length
          ? `read by ${users.map((u) => title(model, u)).join(', ')}`
          : 'not read',
        nodes: [node.id, ...users],
        tone: users.length ? undefined : 'muted',
      });
      if (users.length === 0)
        findings.push({
          id: `data:unused-output:${node.id}.${out}`,
          lens: 'data',
          severity: 'info',
          title: `${node.title} writes ${out}, which nothing reads`,
          detail: `No node input refers to ${node.key}.${out}. Remove the output, or wire it where it is needed.`,
          node: node.id,
          nodes: [node.id],
          fixes: [{ label: 'Open properties', properties: node.id }],
        });
    }
  }
  const inputs: LensItem[] = Object.keys(flowInputs).map((name) => {
    const users = [...(inputUse.get(name) ?? [])];
    return {
      key: `input:${name}`,
      label: `flow.${name}`,
      detail: users.length
        ? `read by ${users.map((u) => title(model, u)).join(', ')}`
        : 'not read by a node input',
      nodes: users,
      tone: users.length ? undefined : 'muted',
    };
  });
  const dataWires = [...wires.values()];
  return {
    lens: 'data',
    chips,
    dataWires,
    stats: [
      { label: 'data wires', value: String(dataWires.length) },
      {
        label: 'unresolved',
        value: String(findings.filter((f) => f.severity === 'warning').length),
      },
      {
        label: 'unused outputs',
        value: String(findings.filter((f) => f.id.startsWith('data:unused')).length),
      },
    ],
    sections: [
      { title: 'Flow inputs', items: inputs, empty: 'The flow has no inputs.' },
      { title: 'Node outputs', items: variables, empty: 'No node declares outputs.' },
    ],
    findings,
    notes: dataWires.length === 0 ? ['No data wires: no node input has a from: reference.'] : [],
  };
}

function unresolved(node: Ulid, nodeTitle: string, name: string, from: string): LensFinding {
  return {
    id: `data:unresolved:${node}.${name}`,
    lens: 'data',
    severity: 'warning',
    title: `${nodeTitle}: ${name} reads ${from}, which does not exist`,
    detail: `"${from}" is neither a flow input nor an output of a node this one can see.`,
    node,
    nodes: [node],
    fixes: [{ label: 'Open properties', properties: node }],
  };
}

// What an exported node tells about itself (AFD-25): the draw.io shape data (Edit Data, Ctrl+M) and
// the hover tooltip. Groups chosen by the product owner: identity and intent, binding, data and
// settings, problems and ports. Values are plain text; several entries go on separate lines.
import { stringify } from 'yaml';
import { keyPath } from '../ai/refs';
import type { FlowModel } from '../flow/model';
import type { OpenPort } from '../flow/openPorts';
import type { Contract, FlowDocument, FlowNode, NodeType } from '../flow/types';
import type { Finding } from '../flow/validate';

/** Attribute name and value, in the order draw.io lists them. */
export type Detail = [name: string, value: string];

export const NODE_TYPE_LABEL: Record<NodeType, string> = {
  start: 'Start',
  end: 'End',
  task: 'Task',
  subflow: 'Subflow',
  decision: 'Decision',
  approval: 'Approval',
  parallel: 'Parallel',
  join: 'Join',
};

/** `name: type (required) = default <- from`, one field per line. */
export function contractText(contract: Contract | undefined): string {
  return Object.entries(contract ?? {})
    .map(([name, f]) => {
      let line = `${name}: ${f?.type ?? 'any'}`;
      if (f?.required) line += ' (required)';
      if (f?.default !== undefined) line += ` = ${JSON.stringify(f.default)}`;
      if (f?.from) line += ` <- ${f.from}`;
      if (f?.targets) line += ' (targets)';
      return line;
    })
    .join('\n');
}

export interface NodeContext {
  model: FlowModel;
  findings: readonly Finding[];
  openPorts: readonly OpenPort[];
}

export function nodeDetails(node: FlowNode, ctx: NodeContext): Detail[] {
  const out: Detail[] = [];
  const add = (name: string, value: unknown) => {
    if (value === undefined || value === null || value === '') return;
    out.push([name, typeof value === 'string' ? value : String(value)]);
  };
  // Identity and intent.
  add('key', node.key);
  add('path', keyPath(ctx.model, node.id));
  add('type', node.type);
  if (node.type !== 'start' && node.type !== 'end') add('status', node.status ?? 'draft');
  add('intent', node.intent);
  add('handler', node.handler);
  add('outcome', node.outcome);
  add('condition', node.condition);
  if (node.type === 'parallel') add('branches', node.branches);
  if (node.type === 'join') add('join_mode', node.join_mode);
  // Binding.
  if (node.impl?.ref) {
    add('binding', `${node.impl.kind}: ${node.impl.ref}`);
    add('collection_version', node.impl.collection_version);
    add('register', node.impl.register);
    if (node.impl.params && Object.keys(node.impl.params).length > 0)
      add('params', stringify(node.impl.params, { lineWidth: 0 }).trimEnd());
  }
  if (node.undo?.ref) add('undo', `${node.undo.kind}: ${node.undo.ref}`);
  // Data and settings.
  add('inputs', contractText(node.inputs));
  add('outputs', contractText(node.outputs));
  const s = node.settings ?? {};
  for (const name of [
    'retries',
    'until',
    'delay',
    'timeout',
    'serial',
    'max_fail_percentage',
    'become',
    'credential',
    'inventory_target',
    'execution_environment',
  ] as const)
    add(name, s[name]);
  if (s.tags?.length) add('tags', s.tags.join(', '));
  if (node.ports?.length) add('optional_ports', node.ports.join(', '));
  if (node.type === 'subflow') {
    const inner = node.subflow?.nodes?.filter((n) => n?.id) ?? [];
    add('steps', inner.length);
    const keyOf = (id: string | undefined) => inner.find((n) => n.id === id)?.key ?? id;
    add('entry', keyOf(node.subflow?.boundary?.in));
    const exits = Object.entries(node.subflow?.boundary?.outputs ?? {}).flatMap(([port, refs]) =>
      (refs ?? []).map((r) => `${port} <- ${keyOf(r?.node)}.${r?.port}`),
    );
    add('exits', exits.join('\n'));
  }
  // Problems and ports.
  add(
    'open_fail_ports',
    ctx.openPorts
      .filter((o) => o.node === node.id)
      .map((o) => o.port)
      .join(', '),
  );
  add(
    'open_on_purpose',
    (ctx.model.doc.decisions ?? [])
      .filter((d) => d?.kind === 'open_on_purpose' && d.node === node.id)
      .map((d) => `${d.port}: ${d.reason ?? '(no reason)'}`)
      .join('\n'),
  );
  add(
    'problems',
    ctx.findings
      .filter((f) => f.node === node.id)
      .map((f) => `${f.severity} ${f.code}: ${f.message}`)
      .join('\n'),
  );
  return out;
}

/** The flow's own data, on the page background (draw.io Edit Data with nothing selected). */
export function flowDetails(doc: FlowDocument, findings: readonly Finding[]): Detail[] {
  const f = doc.flow;
  const out: Detail[] = [
    ['flow', f.name],
    ['flow_key', f.key],
    ['version', String(f.version)],
  ];
  if (f.goal) out.push(['goal', f.goal]);
  if (f.owner) out.push(['owner', f.owner]);
  if (f.runtime?.kind)
    out.push(['runtime', [f.runtime.kind, f.runtime.template].filter(Boolean).join(': ')]);
  if (f.maintenance_window) out.push(['maintenance_window', f.maintenance_window]);
  const inputs = contractText(f.inputs);
  if (inputs) out.push(['inputs', inputs]);
  const count = (sev: string) => findings.filter((x) => x.severity === sev).length;
  out.push([
    'problems',
    `${count('error')} error(s), ${count('warning')} warning(s), ${count('info')} note(s)`,
  ]);
  out.push(['exported_by', 'Ansible Flow Designer']);
  return out;
}

/** Hover text: what the step does, what it runs, its data, what is wrong. */
export function tooltipOf(node: FlowNode, details: readonly Detail[]): string {
  const get = (name: string) => details.find(([n]) => n === name)?.[1];
  const lines = [
    `${node.title} (${NODE_TYPE_LABEL[node.type]}${get('status') ? `, ${get('status')}` : ''})`,
  ];
  if (node.intent) lines.push(node.intent);
  if (get('binding')) lines.push(`Runs ${get('binding')}`);
  if (node.condition) lines.push(`Condition: ${node.condition}`);
  const names = (side: 'inputs' | 'outputs') => Object.keys(node[side] ?? {}).join(', ');
  if (names('inputs')) lines.push(`Inputs: ${names('inputs')}`);
  if (names('outputs')) lines.push(`Outputs: ${names('outputs')}`);
  if (get('open_fail_ports')) lines.push(`Not handled: ${get('open_fail_ports')}`);
  const problems = get('problems')?.split('\n').length ?? 0;
  if (problems > 0) lines.push(`${problems} problem(s): see Edit Data`);
  return lines.join('\n');
}

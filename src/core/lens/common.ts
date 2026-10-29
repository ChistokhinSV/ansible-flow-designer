// Helpers the lenses share: wiring around a node, the flow targets input, chip text.
import { type FlowModel, ROOT } from '../flow/model';
import type { FlowDocument, FlowNode, Ulid } from '../flow/types';
import type { LensChip } from './types';

/** The host_list flow input that seeds start (decision 23), like the run prompt picks it. */
export function targetsInput(doc: FlowDocument): string | undefined {
  const lists = Object.entries(doc.flow.inputs ?? {}).filter(([, f]) => f?.type === 'host_list');
  return (lists.find(([, f]) => f.targets) ?? lists[0])?.[0];
}

export function title(model: FlowModel, id: Ulid): string {
  return model.nodes.get(id)?.node.title ?? id;
}

/** Ports the node's incoming wires leave from (`failed_hosts` from Pre-checks…). */
export function incoming(model: FlowModel, id: Ulid): { from: Ulid; port: string }[] {
  const level = model.levels.get(model.nodes.get(id)?.level ?? '');
  return (level?.edges ?? [])
    .filter((e) => e?.to?.node === id)
    .map((e) => ({ from: e.from.node, port: e.from.port }));
}

/** Nodes wired directly to this one, either way, on its level. */
export function neighbours(model: FlowModel, id: Ulid): FlowNode[] {
  const level = model.levels.get(model.nodes.get(id)?.level ?? '');
  const ids = new Set<Ulid>();
  for (const e of level?.edges ?? []) {
    if (e?.from?.node === id) ids.add(e.to.node);
    if (e?.to?.node === id) ids.add(e.from.node);
  }
  ids.delete(id);
  return [...ids].map((n) => model.nodes.get(n)?.node).filter((n): n is FlowNode => !!n);
}

/** The node as seen from `level`: itself, or the subflow on that level that contains it. */
export function visibleAt(model: FlowModel, id: Ulid, level: string): Ulid | undefined {
  let entry = model.nodes.get(id);
  let current: Ulid = id;
  while (entry) {
    if (entry.level === level) return current;
    if (entry.level === ROOT) return undefined;
    current = entry.level;
    entry = model.nodes.get(entry.level);
  }
  return undefined;
}

/** Task-like nodes: the ones a lens describes (start and end carry flow-level facts only). */
export function isWork(node: FlowNode): boolean {
  return node.type !== 'start' && node.type !== 'end';
}

/** `in: devices, backup_ref +2` within the two-chip budget. */
export function listChip(prefix: string, names: string[], max = 2): LensChip | undefined {
  if (names.length === 0) return undefined;
  const shown = names.slice(0, max).join(', ');
  const more = names.length > max ? ` +${names.length - max}` : '';
  return { text: `${prefix}${shown}${more}`, title: names.join(', ') };
}

export function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

export function joinTitles(titles: string[]): string {
  if (titles.length <= 1) return titles.join('');
  if (titles.length === 2) return `${titles[0]} and ${titles[1]}`;
  return `${titles.slice(0, -1).join(', ')} and ${titles.at(-1)}`;
}

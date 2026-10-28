// Open fail-type ports (D-15) with subflow bubbling (ADR-0004): an inner open fail port counts at
// the parent's port of the same name when the parent has that port, and only counts on its own
// when it cannot bubble.
import { type FlowModel, ROOT } from './model';
import { portsFor } from './ports';
import type { Ulid } from './types';

export interface OpenPort {
  node: Ulid;
  port: string;
  level: string;
}

export function openFailPorts(model: FlowModel): OpenPort[] {
  const decided = new Set(
    (model.doc.decisions ?? [])
      .filter((d) => d?.kind === 'open_on_purpose')
      .map((d) => `${d.node}|${d.port}`),
  );
  const open: OpenPort[] = [];
  for (const level of model.levels.values()) {
    const connected = new Set(level.edges.map((e) => `${e?.from?.node}|${e?.from?.port}`));
    const parent = level.parent ? model.nodes.get(level.parent)?.node : undefined;
    const parentPorts = new Set(parent ? portsFor(parent).map((p) => p.name) : []);
    for (const outputs of Object.values(parent?.subflow?.boundary?.outputs ?? {})) {
      for (const ref of outputs ?? []) connected.add(`${ref.node}|${ref.port}`);
    }
    for (const node of level.nodes) {
      if (!node) continue;
      for (const port of portsFor(node)) {
        if (!port.fail || port.direction !== 'out') continue;
        const id = `${node.id}|${port.name}`;
        if (connected.has(id) || decided.has(id)) continue;
        if (level.id !== ROOT && parentPorts.has(port.name)) continue;
        open.push({ node: node.id, port: port.name, level: level.id });
      }
    }
  }
  return open;
}

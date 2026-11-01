// Building a flow from scratch (AFD-40): one level's nodes, wires and taken keys, and the document
// an import writes. The AWX and playbook importers build with it. IDs are made as nodes and wires
// are, so they sort in the order the importer made them (D-06).
import { type IdFactory, uniqueKey } from './ids';
import { CURRENT_FORMAT } from './migrate';
import type { Contract, Edge, FlowDocument, FlowHeader, FlowNode, PortRef, Ulid } from './types';

export class LevelBuilder {
  readonly nodes: FlowNode[] = [];
  readonly edges: Edge[] = [];
  readonly taken: Set<string>;

  /** `reserved`: keys kept for nodes made later (the top level's `done`). */
  constructor(
    protected readonly newId: IdFactory,
    reserved: readonly string[] = [],
  ) {
    this.taken = new Set(reserved);
  }

  /** A free key from `base` in this level, now taken. */
  key(base: string): string {
    const key = uniqueKey(base, this.taken);
    this.taken.add(key);
    return key;
  }

  /** A wire from `from` to the `in` port of `to`. */
  wire(from: PortRef, to: Ulid): void {
    this.edges.push({ id: this.newId(), from, to: { node: to, port: 'in' } });
  }

  /** The start node, added to the level. */
  start(): FlowNode {
    const start: FlowNode = { id: this.newId(), key: 'start', type: 'start', title: 'Start' };
    this.taken.add('start');
    this.nodes.push(start);
    return start;
  }
}

/** Where an imported flow came from, its goal and its inputs. */
export interface ImportedMeta {
  key: string;
  name: string;
  goal?: string;
  imported_from: NonNullable<FlowHeader['imported_from']>;
  inputs: Contract;
}

/** The document of an imported flow: the current format, flow version 1, the top level built. */
export function importedFlow(id: Ulid, meta: ImportedMeta, top: LevelBuilder): FlowDocument {
  const { key, name, goal, imported_from, inputs } = meta;
  return {
    schema_version: CURRENT_FORMAT,
    flow: { id, key, name, version: 1, ...(goal ? { goal } : {}), imported_from, inputs },
    nodes: top.nodes,
    edges: top.edges,
  };
}

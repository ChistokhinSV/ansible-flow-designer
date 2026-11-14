// The collections a flow needs (AFD-274), for whoever picks or builds its execution environment
// (Ansible Flow Server AFS-33, the CLI, agents). A flow does not declare them: they are read from
// what its steps run. A module or role named by its full name (`cisco.ios.ios_config`) needs its
// collection (`cisco.ios`); `ansible.builtin` and `ansible.legacy` come with ansible-core; a short
// name, a role of the repository and a playbook need nothing here. A binding chosen from the
// module catalog remembers the collection's version it was indexed at (`collection_version`): the
// step was made against it, so the flow asks for at least that. The project's
// `collections/requirements.yml` wins over what the flow says, and a step made against a version
// it does not allow is named.
import { stringify } from 'yaml';
import { satisfies } from '../lens/requirements';
import type { FlowDocument, FlowNode, ImplBinding } from './types';

/** A collection the steps of a flow use. */
export interface FlowCollection {
  name: string;
  /** The versions its bindings were made against (from the catalog), lowest first. */
  versions: string[];
  /** The keys of the steps that use it. */
  nodes: string[];
}

/** One line of what a flow's environment must hold. */
export interface Requirement {
  name: string;
  /** A galaxy version spec: `*`, `>=11.6.0`, or the requirements file's own. */
  version: string;
  /** Where the line comes from: the flow's steps, the requirements file, or both. */
  from: 'flow' | 'requirements' | 'both';
  nodes: string[];
  /** A step was made against a version the requirements file does not allow. */
  conflict?: string;
}

const BUILTIN = new Set(['ansible.builtin', 'ansible.legacy']);
const FQCN = /^([a-z0-9_]+)\.([a-z0-9_]+)\.[A-Za-z0-9_.]+$/;

/** The collection a binding's reference needs; undefined for none. */
export function collectionOf(binding: ImplBinding | null | undefined): string | undefined {
  if (!binding || (binding.kind !== 'module' && binding.kind !== 'role')) return undefined;
  const m = FQCN.exec(binding.ref?.trim() ?? '');
  if (!m) return undefined;
  const name = `${m[1]}.${m[2]}`;
  return BUILTIN.has(name) ? undefined : name;
}

function byVersion(a: string, b: string): number {
  const x = a.split(/[.-]/).map((n) => Number.parseInt(n, 10) || 0);
  const y = b.split(/[.-]/).map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

/** The collections the flow's steps use, every level, step and undo bindings; switched-off steps left out. */
export function flowCollections(doc: FlowDocument): FlowCollection[] {
  const found = new Map<string, { versions: Set<string>; nodes: Set<string> }>();
  // Subflows keep their steps inside them: every level is walked.
  const all: FlowNode[] = [];
  const walk = (nodes: readonly (FlowNode | null | undefined)[] | undefined) => {
    for (const node of nodes ?? []) {
      // A switched-off subflow takes its steps with it.
      if (!node || node.disabled) continue;
      all.push(node);
      walk(node.subflow?.nodes);
    }
  };
  walk(doc.nodes);
  for (const node of all) {
    for (const binding of [node.impl, node.undo]) {
      const name = collectionOf(binding);
      if (!name) continue;
      const entry = found.get(name) ?? { versions: new Set(), nodes: new Set() };
      found.set(name, entry);
      if (node.key) entry.nodes.add(node.key);
      if (binding?.kind === 'module' && binding.collection_version?.trim())
        entry.versions.add(binding.collection_version.trim());
    }
  }
  return [...found.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, e]) => ({
      name,
      versions: [...e.versions].sort(byVersion),
      nodes: [...e.nodes].sort(),
    }));
}

/**
 * What the environment must hold: the flow's collections at least at the versions their steps
 * were made against (`*` when none is known), with the requirements file's lines winning, and its
 * other lines kept.
 */
export function mergeRequirements(
  found: readonly FlowCollection[],
  pins: Readonly<Record<string, string>> = {},
): Requirement[] {
  const out = new Map<string, Requirement>();
  for (const c of found) {
    const pin = pins[c.name];
    const lowest = c.versions[0];
    if (pin === undefined) {
      out.set(c.name, {
        name: c.name,
        version: lowest ? `>=${lowest}` : '*',
        from: 'flow',
        nodes: c.nodes,
      });
      continue;
    }
    const outside = c.versions.filter((v) => !satisfies(v, pin));
    out.set(c.name, {
      name: c.name,
      version: pin,
      from: 'both',
      nodes: c.nodes,
      ...(outside.length
        ? {
            conflict: `steps were made against ${c.name} ${outside.join(', ')}, which ${pin} does not allow`,
          }
        : {}),
    });
  }
  for (const [name, version] of Object.entries(pins))
    if (!out.has(name)) out.set(name, { name, version, from: 'requirements', nodes: [] });
  return [...out.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** The requirements as `ansible-galaxy collection install -r` reads them. */
export function requirementsYaml(requirements: readonly Requirement[]): string {
  return stringify({
    collections: requirements.map((r) =>
      r.version === '*' ? { name: r.name } : { name: r.name, version: r.version },
    ),
  });
}

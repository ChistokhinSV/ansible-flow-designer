// Code lens (04 §7): what each node runs (module, role or playbook, with its collection version) and
// in which execution environment, checked against the environment's catalog and the repository's
// requirements pins (decision M8-5: offline, no Galaxy).
import { buildModel } from '../flow/model';
import type { FlowDocument, Ulid } from '../flow/types';
import { isWork, joinTitles, plural, title } from './common';
import { satisfies } from './requirements';
import type { CodeFacts, LensChip, LensFinding, LensItem, LensView } from './types';

/** `docker: ee-network:1.4` → `ee-network:1.4`. */
export function eeLabel(environment: string): string {
  return environment.replace(/^[a-z]+:\s*/, '');
}

function short(ref: string): string {
  return ref.split('.').at(-1) ?? ref;
}

export function codeLens(doc: FlowDocument, facts: CodeFacts | undefined): LensView {
  const model = buildModel(doc);
  const chips: Record<Ulid, LensChip[]> = {};
  const findings: LensFinding[] = [];
  const env = facts ? eeLabel(facts.environment) : undefined;
  const collections = new Map<string, Set<Ulid>>();
  const ees = new Map<string, Set<Ulid>>();
  let bound = 0;

  for (const { node } of model.nodes.values()) {
    if (!isWork(node)) continue;
    const impl = node.impl;
    const nf = facts?.nodes[node.id];
    const ee = node.settings?.execution_environment ?? env;
    const list: LensChip[] = [];
    if (impl?.ref) {
      bound++;
      const version = nf?.version;
      list.push({
        text: `${short(impl.ref)}${version ? ` ${version}` : ''}`,
        title: `${impl.kind} ${nf?.fqcn ?? impl.ref}${nf?.collection ? ` (${nf.collection})` : ''}`,
        tone: nf && nf.state !== 'ok' && nf.state !== 'unknown' ? 'warn' : undefined,
      });
      if (nf?.collection)
        collections.set(nf.collection, (collections.get(nf.collection) ?? new Set()).add(node.id));
    } else if (node.type === 'task' || node.type === 'subflow') {
      list.push({ text: node.subflow?.nodes?.length ? 'inner steps' : 'TODO stub', tone: 'muted' });
    }
    if (ee) {
      list.push({
        text: ee,
        title: node.settings?.execution_environment
          ? 'node execution environment'
          : 'flow environment',
      });
      ees.set(ee, (ees.get(ee) ?? new Set()).add(node.id));
    }
    chips[node.id] = list.slice(0, 2);

    if (!impl?.ref || !nf) continue;
    const base = { lens: 'code' as const, node: node.id, nodes: [node.id], fixes: [] };
    if (nf.state === 'not-in-ee')
      findings.push({
        ...base,
        id: `code:not-in-ee:${node.id}`,
        severity: 'warning',
        title: `${node.title}: ${impl.ref} is not in the environment`,
        detail: `${facts?.environment ?? 'The environment'} has no ${impl.kind} ${impl.ref}${nf.collection ? `; ${nf.collection} is not installed there` : ''}. Add the collection to the EE or bind another ${impl.kind}.`,
        fixes: [{ label: 'Open properties', properties: node.id }],
      });
    else if (nf.state === 'removed' || nf.state === 'deprecated')
      findings.push({
        ...base,
        id: `code:${nf.state}:${node.id}`,
        severity: 'warning',
        title: `${node.title}: ${nf.fqcn ?? impl.ref} is ${nf.state}`,
        detail: nf.why ? `${nf.why}` : `The catalog marks ${nf.fqcn ?? impl.ref} as ${nf.state}.`,
        fixes: [{ label: 'Open properties', properties: node.id }],
      });
    if (node.settings?.execution_environment && env && node.settings.execution_environment !== env)
      findings.push({
        ...base,
        id: `code:ee-override:${node.id}`,
        severity: 'info',
        title: `${node.title} runs in ${node.settings.execution_environment}`,
        detail: `The flow's environment is ${env}; the catalog and checks describe that one, not ${node.settings.execution_environment}.`,
      });
  }

  const pins = facts?.requirements?.pins ?? {};
  const used: LensItem[] = [...collections.entries()]
    .map(([name, ids]) => {
      const installed = facts?.collections[name];
      const pin = pins[name];
      const ok = !pin || (installed !== undefined && satisfies(installed, pin));
      if (!ok)
        findings.push({
          id: `code:outdated:${name}`,
          lens: 'code',
          severity: 'warning',
          title: installed
            ? `${name} ${installed} does not meet requirements (${pin})`
            : `${name} is required (${pin}) but not installed`,
          detail: `${facts?.requirements?.path ?? 'requirements.yml'} asks for ${name} ${pin}; ${facts?.environment ?? 'the environment'} has ${installed ?? 'none'}. ${joinTitles([...ids].map((id) => title(model, id)))} use it. Rebuild the EE from the requirements.`,
          nodes: [...ids],
          fixes: [],
        });
      return {
        key: `collection:${name}`,
        label: name,
        value: installed ?? 'missing',
        detail: [plural(ids.size, 'node'), pin ? `requires ${pin}` : 'not pinned'].join(' · '),
        nodes: [...ids],
        tone: ok ? undefined : ('warn' as const),
      };
    })
    .sort((a, b) => a.label.localeCompare(b.label));
  const envItems: LensItem[] = [...ees.entries()].map(([ee, ids]) => ({
    key: `ee:${ee}`,
    label: ee,
    detail: plural(ids.size, 'node'),
    nodes: [...ids],
  }));
  const notes: string[] = [];
  if (!facts?.ready)
    notes.push(
      'No catalog of the environment yet: open a node\'s properties, or run "Rebuild Module Catalog".',
    );
  if (facts?.ready && !facts.requirements)
    notes.push('No collections/requirements.yml in the repository: versions are not compared.');
  return {
    lens: 'code',
    chips,
    stats: [
      { label: 'bound nodes', value: String(bound) },
      { label: 'collections', value: String(collections.size) },
      ...(env ? [{ label: 'environment', value: env }] : []),
    ],
    sections: [
      { title: 'Collections in use', items: used, empty: 'No bound node uses a collection.' },
      { title: 'Execution environments', items: envItems, empty: 'No environment configured.' },
    ],
    findings,
    notes,
  };
}

// Facts the lenses need from the environment (M8). The inventory comes from the probe, only when
// a lens asks for it (decision M8-1: the local environment's inventory). Bindings are checked
// against the cached catalog index, so opening a flow never starts a container. Requirements pins
// come from the repository's collections/requirements.yml (decision M8-5).
import * as vscode from 'vscode';
import type { FlowDocument } from '../../core/flow/types';
import { targetsInput } from '../../core/lens/common';
import { inventoryPatterns } from '../../core/lens/inventory';
import { parseRequirements } from '../../core/lens/requirements';
import type { CodeFacts, CodeNodeFacts, InventoryFacts } from '../../core/lens/types';
import type { CatalogService } from '../catalog/catalogService';
import type { ProbeManager } from '../env/environment';
import { inputsKey, parseInput } from '../run/runner';

const REQUIREMENTS = [
  'collections/requirements.yml',
  'collections/requirements.yaml',
  'requirements.yml',
];

/** The flow targets as last entered for a run (or in the lens panel), as one pattern. */
export function rememberedTargets(doc: FlowDocument, state: vscode.Memento): string {
  const name = targetsInput(doc);
  if (!name) return '';
  const value = state.get<Record<string, unknown>>(inputsKey(doc.flow.id), {})[name];
  if (Array.isArray(value)) return value.map(String).join(',');
  return typeof value === 'string' ? value : '';
}

/** Remembers the targets with the run inputs, so the next run prompt offers them too. */
export async function rememberTargets(
  doc: FlowDocument,
  state: vscode.Memento,
  text: string,
): Promise<void> {
  const name = targetsInput(doc);
  if (!name) return;
  const key = inputsKey(doc.flow.id);
  const current = state.get<Record<string, unknown>>(key, {});
  await state.update(key, { ...current, [name]: parseInput('host_list', text) });
}

export async function readInventory(
  uri: vscode.Uri,
  doc: FlowDocument,
  probes: ProbeManager,
  targets: string,
  code?: CodeFacts,
): Promise<{ facts: InventoryFacts; inventory?: string }> {
  const folder = vscode.workspace.getWorkspaceFolder(uri);
  if (!folder) throw new Error('The flow is not in a workspace folder');
  const probe = probes.forFolder(folder.uri);
  if ('error' in probe) throw new Error(probe.error);
  const inventory =
    vscode.workspace.getConfiguration('afd', uri).get<string>('run.inventory', '') || undefined;
  const facts = await probe.client.call<InventoryFacts>(
    'inventory_lens',
    { inventory, targets, patterns: inventoryPatterns(doc, targets, code) },
    120_000,
  );
  return { facts, inventory };
}

async function readText(uri: vscode.Uri): Promise<string | undefined> {
  try {
    return new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
  } catch {
    return undefined;
  }
}

export async function readCode(
  uri: vscode.Uri,
  doc: FlowDocument,
  catalog: CatalogService | undefined,
): Promise<CodeFacts> {
  const folder = vscode.workspace.getWorkspaceFolder(uri);
  const cached = folder ? catalog?.cached(folder) : undefined;
  const index = cached?.index;
  const nodes: Record<string, CodeNodeFacts> = {};
  const playbooks = folder && catalog ? await catalog.playbooks(folder).catch(() => []) : [];
  const walk = (list: FlowDocument['nodes']) => {
    for (const node of list ?? []) {
      if (node.subflow?.nodes) walk(node.subflow.nodes);
      const impl = node.impl;
      if (!impl?.ref) continue;
      if (impl.kind === 'playbook') {
        const pb = playbooks.find((p) => p.path === impl.ref);
        nodes[node.id] = {
          kind: 'playbook',
          ref: impl.ref,
          state: pb ? 'ok' : 'unknown',
          hosts: pb
            ? [...new Set(pb.plays.map((p) => p.hosts).filter((h): h is string => !!h))]
            : undefined,
        };
        continue;
      }
      const parts = impl.ref.split('.');
      const collection = parts.length >= 3 ? `${parts[0]}.${parts[1]}` : undefined;
      if (impl.kind === 'role') {
        const version = collection ? index?.collectionVersion(collection) : undefined;
        nodes[node.id] = {
          kind: 'role',
          ref: impl.ref,
          collection,
          version,
          // Repository roles are not in the catalog; only collection roles can be checked.
          state: !index || !collection ? 'unknown' : version ? 'ok' : 'not-in-ee',
        };
        continue;
      }
      if (!index) {
        nodes[node.id] = { kind: 'module', ref: impl.ref, collection, state: 'unknown' };
        continue;
      }
      const r = index.resolve(impl.ref);
      const fqcn = r.fqcn ?? impl.ref;
      const owner = fqcn.split('.').slice(0, 2).join('.');
      const plugin = r.found ? index.plugin(fqcn) : undefined;
      const deprecated =
        r.deprecated ?? (plugin?.deprecated ? plugin.deprecated.why || 'deprecated' : undefined);
      nodes[node.id] = {
        kind: 'module',
        ref: impl.ref,
        fqcn,
        collection: owner,
        version: index.collectionVersion(owner),
        state: !r.found ? (r.removed ? 'removed' : 'not-in-ee') : deprecated ? 'deprecated' : 'ok',
        why: r.removed ?? deprecated,
      };
    }
  };
  walk(doc.nodes);
  let requirements: CodeFacts['requirements'];
  if (folder)
    for (const rel of REQUIREMENTS) {
      const text = await readText(vscode.Uri.joinPath(folder.uri, rel));
      if (text === undefined) continue;
      const pins = parseRequirements(text);
      if (Object.keys(pins).length > 0 || rel.startsWith('collections/')) {
        requirements = { path: rel, pins };
        break;
      }
    }
  return {
    ready: !!index,
    environment: cached?.environment ?? 'the environment',
    collections: index?.collections() ?? {},
    requirements,
    nodes,
  };
}

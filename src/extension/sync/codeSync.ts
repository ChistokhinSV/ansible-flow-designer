// Re-sync from git (M6, ADR-0012): compile the flow's generated code and every bound role and
// playbook in the environment, read the repository's roles, label it with the Git state. The
// working tree is what gets scanned (decision M6-1); drift itself is computed in core.
import { isAbsolute, relative, sep } from 'node:path';
import * as vscode from 'vscode';
import { tasksFromOf } from '../../core/drift/drift';
import type { CodeScan, CompiledPlaybook, CompiledRole } from '../../core/drift/types';
import { buildModel } from '../../core/flow/model';
import type { FlowDocument } from '../../core/flow/types';
import type { RoleInfo } from '../../core/protocol';
import type { CatalogService } from '../catalog/catalogService';
import { generatedDir } from '../codegen';
import type { ProbeManager } from '../env/environment';
import { gitState } from '../gitHead';

const COMPILE_TIMEOUT = 180_000;

export interface SyncDeps {
  probes: ProbeManager;
  catalog?: CatalogService;
}

/**
 * `uri` relative to the folder, forward slashes (the probe's paths); its full path outside it.
 * path.relative compares Windows drive letters without case (`/c:` and `/C:` both occur).
 */
export function relativeTo(folder: vscode.Uri, uri: vscode.Uri): string {
  const rel = relative(folder.fsPath, uri.fsPath);
  return rel.startsWith('..') || isAbsolute(rel) ? uri.fsPath : rel.split(sep).join('/');
}

export async function scanFlow(
  uri: vscode.Uri,
  doc: FlowDocument,
  deps: SyncDeps,
): Promise<CodeScan> {
  const folder = vscode.workspace.getWorkspaceFolder(uri);
  if (!folder) throw new Error('Open the flow inside a workspace folder to sync it with the code');
  const probe = deps.probes.forFolder(folder.uri);
  if ('error' in probe) throw new Error(probe.error);

  const flowDir = relativeTo(folder.uri, vscode.Uri.joinPath(uri, '..'));
  const generated = relativeTo(
    folder.uri,
    vscode.Uri.joinPath(generatedDir(uri), `${doc.flow.key}.yml`),
  );
  const roles = new Map<string, { name: string; tasks_from: string | null }>();
  const playbooks = new Set<string>();
  const modules = new Set<string>();
  for (const { node } of buildModel(doc).nodes.values()) {
    const impl = node.impl;
    if (!impl?.ref) continue;
    if (impl.kind === 'role') {
      const tf = tasksFromOf(node);
      roles.set(`${impl.ref}|${tf ?? ''}`, { name: impl.ref, tasks_from: tf });
    } else if (impl.kind === 'playbook') playbooks.add(impl.ref.replace(/^\.\//, ''));
    else modules.add(impl.ref);
  }

  const compiled = await probe.client.call<{
    playbooks: CompiledPlaybook[];
    roles: CompiledRole[];
  }>(
    'compile',
    { playbooks: [generated, ...playbooks], roles: [...roles.values()] },
    COMPILE_TIMEOUT,
  );
  const roleInfo = await probe.client.call<RoleInfo[]>('roles', {}, COMPILE_TIMEOUT);
  const [book, ...books] = compiled.playbooks;

  const bound = new Set([...roles.values()].map((r) => r.name));
  const roleDirs = roleInfo.filter((r) => bound.has(r.name)).map((r) => `${r.path}/`);
  const git = await gitState(
    folder.uri,
    (p) => p.startsWith(`${flowDir}/`) || playbooks.has(p) || roleDirs.some((d) => p.startsWith(d)),
  );

  let moduleReturns: Record<string, string[]> | undefined;
  const index = deps.catalog?.cached(folder)?.index;
  if (index && modules.size > 0) {
    moduleReturns = {};
    for (const ref of modules) {
      const fqcn = index.resolve(ref).fqcn;
      const plugin = fqcn ? index.plugin(fqcn) : undefined;
      if (plugin) moduleReturns[ref] = Object.keys(plugin.returns ?? {});
    }
  }

  return {
    at: new Date().toISOString(),
    environment: probe.label,
    git,
    generated: book ?? { path: generated, error: 'not compiled', plays: [] },
    roles: compiled.roles,
    playbooks: books,
    roleInfo,
    moduleReturns,
  };
}

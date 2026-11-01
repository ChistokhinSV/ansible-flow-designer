// Re-import from Source (AFD-61, ADR-0021): a flow imported as is from a playbook reads the playbook
// again and merges it (core/import/reimport). The merge is previewed as a list: the source's changes
// to steps the designer left alone, new steps and steps whose task is gone are picked; conflicts
// (changed in both) are not, so the designer's version stays unless picked. A change not taken is
// noted on the step and not offered again until the source changes it again. One edit, one undo.
import * as vscode from 'vscode';
import { parse } from 'yaml';
import { modelOf } from '../../core/flow/model';
import type { FlowDocument } from '../../core/flow/types';
import { importPlaybook } from '../../core/import/playbook';
import { planReimport, type ReimportPlan } from '../../core/import/reimport';
import { readPlaybook } from '../../core/import/source';
import type { CommandOutcome } from '../flowSession';
import type { Host } from '../host';
import { workspaceSource } from './common';

/** What tests pass instead of picking. */
export interface ReimportRequest {
  /** The conflicts that take the source's version, by step key, or all of them. */
  take?: string[] | 'all';
}

export interface ReimportOutcome {
  plan?: ReimportPlan;
  applied?: CommandOutcome;
  error?: string;
}

type Change = 'update' | 'conflict' | 'add' | 'gone';
type Item = vscode.QuickPickItem & { change?: Change; index?: number };

function previewItems(plan: ReimportPlan, flow: FlowDocument): Item[] {
  const title = (id?: string) => (id ? modelOf(flow).nodes.get(id)?.node.title : undefined);
  const items: Item[] = [];
  const section = (label: string) =>
    items.push({ label, kind: vscode.QuickPickItemKind.Separator });
  if (plan.conflicts.length) section('Changed here and in the source: pick to take the source');
  for (const [index, u] of plan.conflicts.entries())
    items.push({
      label: `$(warning) ${title(u.node) ?? u.key}`,
      description: u.changed.join(', '),
      change: 'conflict',
      index,
    });
  if (plan.updates.length) section('Changed in the source only');
  for (const [index, u] of plan.updates.entries())
    items.push({
      label: `$(arrow-down) ${title(u.node) ?? u.key}`,
      description: u.changed.join(', '),
      picked: true,
      change: 'update',
      index,
    });
  if (plan.adds.length) section('New tasks');
  for (const [index, a] of plan.adds.entries())
    items.push({
      label: `$(add) ${a.step.title}`,
      description: a.after ? `after ${title(a.after)}` : 'at the end',
      picked: true,
      change: 'add',
      index,
    });
  if (plan.gone.length) section('No longer in the source: flagged, not deleted');
  for (const [index, g] of plan.gone.entries())
    items.push({
      label: `$(circle-slash) ${title(g.node) ?? g.key}`,
      picked: true,
      change: 'gone',
      index,
    });
  return items;
}

export async function reimportFromSource(
  host: Host,
  uri?: vscode.Uri,
  request?: ReimportRequest,
): Promise<ReimportOutcome> {
  const fail = (error: string): ReimportOutcome => {
    if (!host.testMode) void vscode.window.showErrorMessage(error);
    return { error };
  };
  const doc = await host.resolveTargetFlow(uri);
  if (!doc) return { error: 'No flow' };
  let flow: FlowDocument;
  try {
    flow = parse(doc.getText()) as FlowDocument;
  } catch {
    return fail('The flow has YAML errors; fix them in the text editor first');
  }
  const from = flow?.flow?.imported_from;
  if (from?.kind !== 'playbook' || !from.path)
    return fail('Re-import from Source works on flows imported from a playbook');
  if (![...modelOf(flow).nodes.values()].some((e) => e.node.origin))
    return fail(
      'Its steps do not record their tasks (imported before 0.39): import the playbook again to re-import it later',
    );
  const folder = vscode.workspace.getWorkspaceFolder(doc.uri);
  if (!folder) return fail('Open the repository as a workspace folder first');
  const resolveModule = host.playbookDeps.resolveModule?.(folder);
  const read = await readPlaybook(workspaceSource(folder), from.path, {
    ...(resolveModule ? { resolveModule } : {}),
  });
  if (!read.playbook?.plays.length)
    return fail(`${from.path}: ${read.notes.join(' ') || 'no longer a playbook'}`);
  const key = flow.flow.key;
  const fresh = importPlaybook(read.playbook, {
    key,
    newId: host.deps.newId,
    generatedDir: `flows/${key}/generated`,
  }).doc;
  const plan = planReimport(flow, fresh);
  const total = plan.updates.length + plan.conflicts.length + plan.adds.length + plan.gone.length;
  if (total === 0) {
    if (!host.testMode)
      void vscode.window.showInformationMessage(`Up to date: ${from.path} has no new changes`);
    return { plan };
  }

  let picked: { change?: Change; index?: number }[];
  if (request) {
    const take = request.take ?? [];
    picked = [
      ...plan.updates.map((_, index) => ({ change: 'update' as const, index })),
      ...plan.conflicts.flatMap((c, index) =>
        take === 'all' || take.includes(c.key) ? [{ change: 'conflict' as const, index }] : [],
      ),
      ...plan.adds.map((_, index) => ({ change: 'add' as const, index })),
      ...plan.gone.map((_, index) => ({ change: 'gone' as const, index })),
    ];
  } else {
    const chosen = await vscode.window.showQuickPick(previewItems(plan, flow), {
      title: `Re-import from ${from.path}`,
      placeHolder: `${plan.same} step(s) unchanged; the picked changes apply as one edit (one undo)`,
      canPickMany: true,
      ignoreFocusOut: true,
    });
    if (!chosen) return { plan, error: 'Cancelled' };
    picked = chosen;
  }
  const of = (change: Change) =>
    picked.filter((p) => p.change === change).map((p) => p.index as number);
  const took = new Set([
    ...of('update').map((i) => plan.updates[i]),
    ...of('conflict').map((i) => plan.conflicts[i]),
  ]);
  took.delete(undefined);
  // A change not taken keeps the designer's version and is not offered again.
  const keep = [...plan.updates, ...plan.conflicts]
    .filter((u) => !took.has(u))
    .map((u) => ({ node: u.node, design: u.design }));
  const applied = await host.sessionFor(doc).runCommand({
    kind: 'reimport',
    updates: [...took].filter((u) => u !== undefined),
    adds: of('add')
      .map((i) => plan.adds[i])
      .filter((a) => a !== undefined),
    gone: of('gone')
      .map((i) => plan.gone[i]?.node)
      .filter((g) => g !== undefined),
    keep,
  });
  if (!applied.ok) return fail(applied.error ?? 'Re-import failed');
  if (!host.testMode)
    void vscode.window.showInformationMessage(
      `Re-imported ${from.path}: ${took.size} step(s) updated, ${of('add').length} new, ${of('gone').length} flagged as gone${keep.length ? `, ${keep.length} kept as designed` : ''}`,
    );
  return { plan, applied };
}

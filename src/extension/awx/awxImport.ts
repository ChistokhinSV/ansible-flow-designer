// Import AWX Workflow (M9, D-31, ADR-0015): a workflow job template from the AWX API or an
// `awx export` file becomes a new flow at flows/<key>/<key>.flow.yaml, laid out top-down with ELK
// at every level, and opens in the designer. A one-time copy: AWX is only read.
import * as vscode from 'vscode';
import { flowText, type ImportResult, importWorkflow } from '../../core/awx/import';
import {
  type AwxExport,
  exportWorkflows,
  playbooksOf,
  type WorkflowSource,
  workflowFromApi,
  workflowFromExport,
} from '../../core/awx/workflow';
import { type IdFactory, SLUG, slugify } from '../../core/flow/ids';
import { layoutAll } from '../autoLayout';
import { awxClient } from './awxRun';

export type ImportSource =
  | { kind: 'awx'; name?: string }
  | { kind: 'file'; path?: string; name?: string };

/** What tests pass instead of picking (every field optional: a missing one is asked for). */
export interface ImportRequest {
  source?: ImportSource;
  folder?: vscode.Uri;
  key?: string;
}

export interface ImportOutcome {
  uri?: vscode.Uri;
  notes: string[];
  counts?: ImportResult['counts'];
  error?: string;
}

const cancelled = (): ImportOutcome => ({ notes: [], error: 'Cancelled' });

async function exists(uri: vscode.Uri): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(uri);
    return true;
  } catch {
    return false;
  }
}

async function pickFolder(given?: vscode.Uri): Promise<vscode.WorkspaceFolder | undefined> {
  if (given) return vscode.workspace.getWorkspaceFolder(given);
  const folders = vscode.workspace.workspaceFolders ?? [];
  return folders.length > 1
    ? vscode.window.showWorkspaceFolderPick({ placeHolder: 'Repository for the imported flow' })
    : folders[0];
}

async function fromAwx(
  folder: vscode.WorkspaceFolder,
  secrets: vscode.SecretStorage,
  name?: string,
): Promise<{ src: WorkflowSource; id: number } | string> {
  const client = await awxClient(folder.uri, secrets);
  if (typeof client === 'string') return client;
  const list = await client.list<{ id: number; name: string; description?: string }>(
    'workflow_job_templates',
  );
  if (list.length === 0) return `AWX at ${client.base} has no workflow job templates`;
  const chosen = name
    ? list.find((w) => w.name === name)
    : (
        await vscode.window.showQuickPick(
          list.map((w) => ({ label: w.name, description: w.description, w })),
          { title: 'Import AWX Workflow', placeHolder: `Workflow job template in ${client.base}` },
        )
      )?.w;
  if (!chosen) return name ? `AWX has no workflow job template "${name}"` : 'Cancelled';
  return { src: await workflowFromApi(client, chosen.id), id: chosen.id };
}

async function fromFile(path?: string, name?: string): Promise<WorkflowSource | string> {
  const uri = path
    ? vscode.Uri.file(path)
    : (
        await vscode.window.showOpenDialog({
          title: 'AWX export file (awx export --workflow_job_templates --job_templates)',
          filters: { 'AWX export': ['json'] },
          canSelectMany: false,
        })
      )?.[0];
  if (!uri) return 'Cancelled';
  let data: unknown;
  try {
    data = JSON.parse(new TextDecoder().decode(await vscode.workspace.fs.readFile(uri)));
  } catch (e) {
    return `Cannot read ${uri.fsPath} as JSON: ${(e as Error).message}`;
  }
  const names = exportWorkflows(data);
  if (typeof names === 'string') return names;
  const chosen =
    name ??
    (names.length === 1
      ? names[0]
      : await vscode.window.showQuickPick(names, {
          title: 'Import AWX Workflow',
          placeHolder: 'Workflow job template in the export file',
        }));
  if (!chosen) return 'Cancelled';
  if (!names.includes(chosen)) return `The export file has no workflow "${chosen}"`;
  return workflowFromExport(data as AwxExport, chosen);
}

export async function importAwxWorkflow(
  secrets: vscode.SecretStorage,
  newId: IdFactory,
  request: ImportRequest = {},
): Promise<ImportOutcome> {
  const folder = await pickFolder(request.folder);
  if (!folder) return { notes: [], error: 'Open a folder (the automation repository) first.' };
  let source: ImportSource | undefined = request.source;
  if (!source) {
    const pick = await vscode.window.showQuickPick(
      [
        {
          label: 'From AWX',
          description: 'the workflow job templates of afd.awx.url',
          from: 'awx',
        },
        {
          label: 'From an export file…',
          description: 'awx export --workflow_job_templates --job_templates',
          from: 'file',
        },
      ] as const,
      { title: 'Import AWX Workflow' },
    );
    if (!pick) return cancelled();
    source = pick.from === 'awx' ? { kind: 'awx' } : { kind: 'file' };
  }
  const from = source;

  let src: WorkflowSource;
  let sourceId: number | undefined;
  try {
    const got =
      from.kind === 'awx'
        ? await fromAwx(folder, secrets, from.name)
        : await fromFile(from.path, from.name);
    if (typeof got === 'string') return { notes: [], error: got };
    if ('src' in got) {
      src = got.src;
      sourceId = got.id;
    } else src = got;
  } catch (e) {
    return { notes: [], error: (e as Error).message };
  }

  const dir = (key: string) => vscode.Uri.joinPath(folder.uri, 'flows', key);
  let key = request.key;
  if (!key) {
    key = await vscode.window.showInputBox({
      title: `Import "${src.name}"`,
      prompt: 'Flow key (the folder under flows/)',
      value: slugify(src.name, 'imported'),
      validateInput: async (v) =>
        !SLUG.test(v)
          ? 'Lowercase letters, digits and dashes'
          : (await exists(dir(v)))
            ? `flows/${v} already exists`
            : undefined,
    });
    if (!key) return cancelled();
  }
  if (!SLUG.test(key)) return { notes: [], error: `"${key}" is not a flow key` };
  const uri = vscode.Uri.joinPath(dir(key), `${key}.flow.yaml`);
  if (await exists(dir(key))) return { notes: [], error: `flows/${key} already exists` };

  const present = new Set<string>();
  for (const ref of playbooksOf(src))
    if (await exists(vscode.Uri.joinPath(folder.uri, ...ref.replace(/^\.?\//, '').split('/'))))
      present.add(ref);
  const result = importWorkflow(src, {
    key,
    newId,
    sourceId,
    hasPlaybook: (ref) => present.has(ref),
  });
  await layoutAll(result.doc);
  await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(flowText(result.doc)));
  return { uri, notes: result.notes, counts: result.counts };
}

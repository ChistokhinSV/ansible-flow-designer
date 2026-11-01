// Import AWX Workflow or Job Template (M9 D-31 ADR-0015, AFD-26): a workflow or job template from
// the AWX API or an `awx export` file becomes a new flow at flows/<key>/<key>.flow.yaml, and opens
// in the designer.
// Job templates whose playbook is in the repository become subflows of the playbook's steps; a
// workflow is laid out top-down with ELK at every level. A one-time copy: AWX is only read.
import * as vscode from 'vscode';
import { type ImportResult, importWorkflow } from '../../core/awx/import';
import { sanitizedExport } from '../../core/awx/sanitize';
import {
  type AwxExport,
  exportTemplates,
  jobTemplateFromApi,
  jobTemplateFromExport,
  playbooksOf,
  type WorkflowSource,
  workflowFromApi,
  workflowFromExport,
} from '../../core/awx/workflow';
import { type IdFactory, SLUG } from '../../core/flow/ids';
import { flowText } from '../../core/flow/text';
import { importPrompt } from '../../core/import/prompt';
import type { PlaybookForm } from '../../core/import/source';
import { readPlaybook } from '../../core/import/source';
import { layoutAll } from '../../node/autoLayout';
import { type AiStart, type ImportMode, pickMode, startAiImport } from '../import/aiStart';
import { askKey, exists, flowDir, pickFolder, workspaceSource } from '../import/common';
import { awxClient } from './awxRun';

export type TemplateKind = 'workflow' | 'job';

export type ImportSource =
  | { kind: 'awx'; name?: string; template?: TemplateKind }
  | { kind: 'file'; path?: string; name?: string; template?: TemplateKind };

/** What tests pass instead of picking (every field optional: a missing one is asked for). */
export interface ImportRequest {
  source?: ImportSource;
  folder?: vscode.Uri;
  key?: string;
  /** AFD-27: as is, or with an AI assistant (asked when absent). */
  mode?: ImportMode;
  /** AFD-27: where the AI prompt goes (asked when absent). */
  via?: 'chat' | 'clipboard';
}

export interface ImportOutcome {
  uri?: vscode.Uri;
  notes: string[];
  counts?: ImportResult['counts'];
  error?: string;
  /** AFD-27: the sanitized export the assistant reads, the prompt, and where it went. */
  exportFile?: vscode.Uri;
  prompt?: string;
  started?: AiStart;
}

const cancelled = (): ImportOutcome => ({ notes: [], error: 'Cancelled' });

interface Picked {
  src: WorkflowSource;
  template: TemplateKind;
  id?: number;
}

type Choice = vscode.QuickPickItem & { template?: TemplateKind; name?: string; id?: number };

/** One list, workflows first, with a separator per kind. */
function choices(
  workflows: { name: string; description?: string; id?: number }[],
  jobs: { name: string; description?: string; id?: number }[],
): Choice[] {
  const group = (label: string, list: typeof workflows, template: TemplateKind): Choice[] =>
    list.length
      ? [
          { label, kind: vscode.QuickPickItemKind.Separator },
          ...list.map((t) => ({
            label: t.name,
            description: t.description,
            template,
            name: t.name,
            id: t.id,
          })),
        ]
      : [];
  return [
    ...group('Workflow templates', workflows, 'workflow'),
    ...group('Job templates', jobs, 'job'),
  ];
}

async function fromAwx(
  folder: vscode.WorkspaceFolder,
  secrets: vscode.SecretStorage,
  from: Extract<ImportSource, { kind: 'awx' }>,
): Promise<Picked | string> {
  const client = await awxClient(folder.uri, secrets);
  if ('error' in client) return client.error;
  type Row = { id: number; name: string; description?: string };
  const workflows = from.template === 'job' ? [] : await client.list<Row>('workflow_job_templates');
  const jobs = from.template === 'workflow' ? [] : await client.list<Row>('job_templates');
  if (!workflows.length && !jobs.length) return `AWX at ${client.base} has no templates`;
  let chosen: Choice | undefined;
  if (from.name) {
    const w = workflows.find((t) => t.name === from.name);
    const j = jobs.find((t) => t.name === from.name);
    chosen = w
      ? { label: w.name, template: 'workflow', id: w.id }
      : j
        ? { label: j.name, template: 'job', id: j.id }
        : undefined;
    if (!chosen) return `AWX has no template "${from.name}"`;
  } else {
    chosen = await vscode.window.showQuickPick(choices(workflows, jobs), {
      title: 'Import AWX Workflow or Job Template',
      placeHolder: `Workflow or job template in ${client.base}`,
    });
    if (!chosen?.id) return 'Cancelled';
  }
  const id = chosen.id as number;
  return chosen.template === 'job'
    ? { src: await jobTemplateFromApi(client, id), template: 'job', id }
    : { src: await workflowFromApi(client, id), template: 'workflow', id };
}

async function fromFile(from: Extract<ImportSource, { kind: 'file' }>): Promise<Picked | string> {
  const uri = from.path
    ? vscode.Uri.file(from.path)
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
  const names = exportTemplates(data);
  if (typeof names === 'string') return names;
  let template = from.template;
  let name = from.name;
  if (name && !template)
    template = names.workflows.includes(name)
      ? 'workflow'
      : names.jobs.includes(name)
        ? 'job'
        : undefined;
  if (!name) {
    const all = choices(
      names.workflows.map((n) => ({ name: n })),
      names.jobs.map((n) => ({ name: n })),
    ).filter((c) => !template || c.template === template);
    const real = all.filter((c) => c.template);
    const pick =
      real.length === 1
        ? real[0]
        : await vscode.window.showQuickPick(all, {
            title: 'Import AWX Workflow or Job Template',
            placeHolder: 'Workflow or job template in the export file',
          });
    if (!pick?.name) return 'Cancelled';
    name = pick.name;
    template = pick.template;
  }
  const list = template === 'job' ? names.jobs : names.workflows;
  if (!template || !list.includes(name)) return `The export file has no template "${name}"`;
  return template === 'job'
    ? { src: jobTemplateFromExport(data as AwxExport, name), template }
    : { src: workflowFromExport(data as AwxExport, name), template };
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
          description: 'the workflow and job templates of afd.awx.url',
          from: 'awx',
        },
        {
          label: 'From an export file…',
          description: 'awx export --workflow_job_templates --job_templates',
          from: 'file',
        },
      ] as const,
      { title: 'Import AWX Workflow or Job Template' },
    );
    if (!pick) return cancelled();
    source = pick.from === 'awx' ? { kind: 'awx' } : { kind: 'file' };
  }
  const from = source;

  let picked: Picked;
  try {
    const got = from.kind === 'awx' ? await fromAwx(folder, secrets, from) : await fromFile(from);
    if (typeof got === 'string') return { notes: [], error: got };
    picked = got;
  } catch (e) {
    return { notes: [], error: (e as Error).message };
  }
  const { src } = picked;

  let key = request.key;
  if (!key) {
    key = await askKey(folder, `Import "${src.name}"`, src.name);
    if (!key) return cancelled();
  }
  if (!SLUG.test(key)) return { notes: [], error: `"${key}" is not a flow key` };
  const uri = vscode.Uri.joinPath(flowDir(folder, key), `${key}.flow.yaml`);
  if (await exists(flowDir(folder, key)))
    return { notes: [], error: `flows/${key} already exists` };
  const mode = request.mode ?? (await pickMode(`"${src.name}"`));
  if (!mode) return cancelled();
  if (mode === 'ai') {
    // The assistant reads AWX through a sanitized export: the token stays here (decision 5).
    const exportFile = vscode.Uri.joinPath(flowDir(folder, key), 'source', 'awx-export.json');
    const data = sanitizedExport(src, picked.template);
    await vscode.workspace.fs.writeFile(
      exportFile,
      new TextEncoder().encode(`${JSON.stringify(data, null, 2)}\n`),
    );
    const prompt = importPrompt({
      sources: [`flows/${key}/source/awx-export.json`],
      targets: [`flows/${key}/${key}.flow.yaml`],
      template: { kind: picked.template, name: src.name },
    });
    return {
      notes: [],
      exportFile,
      prompt,
      started: await startAiImport(prompt, request.via),
    };
  }

  // Playbooks in the repository: present ones bind, readable ones expand into steps (AFD-26).
  const io = workspaceSource(folder);
  const present = new Set<string>();
  const playbooks = new Map<string, PlaybookForm>();
  for (const ref of playbooksOf(src)) {
    const path = ref.replace(/^\.?\//, '');
    if (!(await exists(vscode.Uri.joinPath(folder.uri, ...path.split('/'))))) continue;
    present.add(ref);
    const read = await readPlaybook(io, path);
    if (read.playbook?.plays.length) playbooks.set(ref, read.playbook);
  }
  const result = importWorkflow(src, {
    key,
    newId,
    sourceId: picked.id,
    hasPlaybook: (ref) => present.has(ref),
    playbooks,
    kind: picked.template === 'job' ? 'awx_job_template' : 'awx_workflow',
  });
  await layoutAll(result.doc);
  await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(flowText(result.doc)));
  return { uri, notes: result.notes, counts: result.counts };
}

// Run in AWX (M7, ADR-0013): the flow's job template, launched with the flow inputs as extra vars,
// followed through its job events and mapped back to nodes like local runs. AWX's RBAC and
// activity stream are the audit of record (decision 18); the local audit log records the launch.
// The token lives in SecretStorage only.
import * as vscode from 'vscode';
import { awxEventsToLines, playNodes } from '../../core/awx/events';
import { type AwxJob, type AwxJobEvent, type AwxNamed, FINISHED } from '../../core/awx/types';
import { optionA } from '../../core/engine/optionA';
import { resolvePattern, targetUses } from '../../core/engine/targets';
import type { FlowCommand } from '../../core/flow/commands';
import { parseFlow } from '../../core/flow/document';
import { buildModel } from '../../core/flow/model';
import type { SchemaValidator } from '../../core/flow/schema';
import { nodeDesigns } from '../../core/flow/semantic';
import type { FlowDocument } from '../../core/flow/types';
import type { RunView } from '../../core/protocol';
import { summarizeRun } from '../../core/run/events';
import { generatedDir, generateFlow } from '../codegen';
import { authorName, gitState } from '../gitHead';
import { appendAudit } from '../run/audit';
import { collectInputs, stamp, targetsOf } from '../run/runner';
import { relativeTo } from '../sync/codeSync';
import { runWorkflow, setupWorkflow } from './awxWorkflow';
import { AwxClient } from './client';

const POLL_MS = 2000;
/** Events are stored after the job ends; give them this long to arrive. */
const EVENTS_GRACE_MS = 20_000;
const PROJECT_SYNC_MS = 180_000;

export interface AwxDeps {
  secrets: vscode.SecretStorage;
  storage: vscode.Uri;
  state: vscode.Memento;
  schema: SchemaValidator;
  testMode: boolean;
  report(run: RunView): void;
  runCommand(command: FlowCommand): Promise<{ ok: boolean; error?: string }>;
}

export interface AwxPicks {
  project: string;
  inventory: string;
  environment?: string;
  credentials?: string[];
}

export function templateName(doc: FlowDocument): string {
  return `AFD · ${doc.flow.key}`;
}

function settings(scope: vscode.Uri): { url: string; verifyTls: boolean } {
  const c = vscode.workspace.getConfiguration('afd', scope);
  return {
    url: (c.get<string>('awx.url', '') ?? '').trim().replace(/\/+$/, ''),
    verifyTls: c.get('awx.verifyTls', true),
  };
}

const tokenKey = (url: string) => `afd.awx.token:${url}`;

export async function awxClient(
  scope: vscode.Uri,
  secrets: vscode.SecretStorage,
): Promise<AwxClient | string> {
  const { url, verifyTls } = settings(scope);
  if (!url) return 'Set afd.awx.url to the AWX address first';
  const token = await secrets.get(tokenKey(url));
  if (!token) return `No AWX token for ${url}: run "Ansible Flow: Set AWX Token"`;
  return new AwxClient(url, token, { verifyTls });
}

/** Stores a token for the configured AWX after checking it (never shown or logged again). */
export async function setToken(
  scope: vscode.Uri,
  secrets: vscode.SecretStorage,
  given?: string,
): Promise<string | undefined> {
  const { url, verifyTls } = settings(scope);
  if (!url) return 'Set afd.awx.url to the AWX address first';
  const token =
    given ??
    (await vscode.window.showInputBox({
      title: `AWX token for ${url}`,
      prompt: 'A personal access token (Users → Tokens in AWX); stored in VS Code SecretStorage',
      password: true,
      ignoreFocusOut: true,
    }));
  if (!token) return 'Cancelled';
  try {
    const me = await new AwxClient(url, token, { verifyTls }).get<{
      results: { username: string }[];
    }>('/api/v2/me/');
    await secrets.store(tokenKey(url), token);
    if (!given)
      void vscode.window.showInformationMessage(
        `AWX token stored for ${me.results[0]?.username ?? 'the user'} at ${url}.`,
      );
    return undefined;
  } catch (e) {
    return (e as Error).message;
  }
}

export async function clearToken(scope: vscode.Uri, secrets: vscode.SecretStorage): Promise<void> {
  const { url } = settings(scope);
  if (url) await secrets.delete(tokenKey(url));
}

async function pick<T extends AwxNamed>(
  items: T[],
  title: string,
  name?: string,
  optional = false,
): Promise<T | undefined | null> {
  if (name) return items.find((i) => i.name === name) ?? null;
  const choice = await vscode.window.showQuickPick(
    [
      ...(optional ? [{ label: '(none)', item: undefined as T | undefined }] : []),
      ...items.map((i) => ({ label: i.name, item: i as T | undefined })),
    ],
    { title, ignoreFocusOut: true },
  );
  return choice ? choice.item : null;
}

/** Why AWX cannot run these playbooks yet (after one project update), or undefined. */
async function missingPlaybooks(
  awx: AwxClient,
  project: AwxNamed,
  playbooks: string[],
): Promise<string | undefined> {
  let books = await awx.get<string[]>(`/api/v2/projects/${project.id}/playbooks/`);
  if (playbooks.every((p) => books.includes(p))) return undefined;
  const status = await waitForProject(awx, project.id);
  books = await awx.get<string[]>(`/api/v2/projects/${project.id}/playbooks/`);
  const missing = playbooks.filter((p) => !books.includes(p));
  return missing.length === 0
    ? undefined
    : `AWX project "${project.name}" has no ${missing.join(', ')} (update ${status}): commit and push the flow, then try again`;
}

async function waitForProject(awx: AwxClient, project: number): Promise<string> {
  const update = await awx.post<{ id: number }>(`/api/v2/projects/${project}/update/`, {});
  const t0 = Date.now();
  while (Date.now() - t0 < PROJECT_SYNC_MS) {
    const u = await awx.get<{ status: string }>(`/api/v2/project_updates/${update.id}/`);
    if (['successful', 'failed', 'error', 'canceled'].includes(u.status)) return u.status;
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
  return 'timeout';
}

/**
 * "Set up AWX template" (decision M7-3): picks the AWX project, inventory, execution environment
 * and credentials, creates or updates the job template for the generated playbook, and writes
 * its name to flow.runtime (one edit).
 */
export async function setupTemplate(
  document: vscode.TextDocument,
  deps: AwxDeps,
  picks?: AwxPicks,
): Promise<{ ok: boolean; error?: string; template?: string }> {
  const doc = parseFlow(document.getText()).doc;
  const folder = vscode.workspace.getWorkspaceFolder(document.uri);
  if (!doc || !folder)
    return { ok: false, error: 'Open a valid flow inside its repository folder' };
  const awx = await awxClient(document.uri, deps.secrets);
  if (typeof awx === 'string') return { ok: false, error: awx };
  try {
    const project = await pick(
      await awx.list<AwxNamed>('projects'),
      'AWX project that holds this repository',
      picks?.project,
    );
    if (!project)
      return {
        ok: false,
        error: project === null && picks ? `No AWX project ${picks.project}` : 'Cancelled',
      };
    const inventory = await pick(
      await awx.list<AwxNamed>('inventories'),
      'Inventory',
      picks?.inventory,
    );
    if (!inventory)
      return {
        ok: false,
        error: inventory === null && picks ? `No AWX inventory ${picks.inventory}` : 'Cancelled',
      };
    const ees = await awx.list<AwxNamed>('execution_environments');
    const ee = picks
      ? picks.environment
        ? ees.find((e) => e.name === picks.environment)
        : undefined
      : await pick(ees, 'Execution environment (ansible-core 2.19+)', undefined, true);
    if (ee === null) return { ok: false, error: 'Cancelled' };
    let credentials: AwxNamed[] = [];
    const all = await awx.list<AwxNamed>('credentials');
    if (picks) credentials = all.filter((c) => picks.credentials?.includes(c.name));
    else {
      const chosen = await vscode.window.showQuickPick(
        all.map((c) => ({ label: c.name, item: c })),
        { title: 'Credentials (machine, vault …)', canPickMany: true, ignoreFocusOut: true },
      );
      if (!chosen) return { ok: false, error: 'Cancelled' };
      credentials = chosen.map((c) => c.item);
    }
    // Top-level approvals: an AWX workflow of segment playbooks (AFD-11, ADR-0016).
    const plan = optionA.generate(doc, { source: document.uri.path.split('/').pop() ?? '' });
    const blocked = plan.findings.filter((f) => f.code === 'codegen-segments');
    if (blocked.length > 0)
      return {
        ok: false,
        error: `AWX cannot run this flow as a workflow: ${blocked.map((f) => f.message).join('; ')}`,
      };
    if (plan.segments) {
      const dir = generatedDir(document.uri);
      const playbooks = plan.segments.map((s) =>
        relativeTo(folder.uri, vscode.Uri.joinPath(dir, s.file)),
      );
      const missing = await missingPlaybooks(awx, project, playbooks);
      if (missing) return { ok: false, error: missing };
      const name = await setupWorkflow(awx, doc, plan.segments, {
        project,
        inventory,
        environment: ee ?? undefined,
        credentials,
        playbooks,
      });
      if (doc.flow.runtime?.template !== name || doc.flow.runtime?.kind !== 'awx_workflow') {
        const r = await deps.runCommand({
          kind: 'updateFlow',
          patch: { runtime: { ...doc.flow.runtime, kind: 'awx_workflow', template: name } },
        });
        if (!r.ok) return { ok: false, error: r.error };
      }
      return { ok: true, template: name };
    }
    const playbook = relativeTo(
      folder.uri,
      vscode.Uri.joinPath(generatedDir(document.uri), `${doc.flow.key}.yml`),
    );
    const missing = await missingPlaybooks(awx, project, [playbook]);
    if (missing) return { ok: false, error: missing };
    const name = templateName(doc);
    await awx.upsertTemplate({
      name,
      description: `Ansible Flow Designer: ${doc.flow.name} (${doc.flow.key}), generated playbook`,
      project: project.id,
      playbook,
      inventory: inventory.id,
      execution_environment: ee?.id,
      credentials: credentials.map((c) => c.id),
    });
    if (doc.flow.runtime?.template !== name || doc.flow.runtime?.kind !== 'awx_job') {
      const r = await deps.runCommand({
        kind: 'updateFlow',
        patch: { runtime: { ...doc.flow.runtime, kind: 'awx_job', template: name } },
      });
      if (!r.ok) return { ok: false, error: r.error };
    }
    return { ok: true, template: name };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

/** Launch in AWX: inputs, a confirmation, the job, then its events until it ends. */
export async function launchInAwx(
  document: vscode.TextDocument,
  deps: AwxDeps,
  options: { inputs?: Record<string, unknown>; yes?: boolean } = {},
): Promise<RunView> {
  const id = stamp();
  const startedAt = new Date().toISOString();
  const fail = (error: string): RunView => {
    const run: RunView = { id, mode: 'real', state: 'error', startedAt, error, source: 'awx' };
    deps.report(run);
    return run;
  };
  if (document.isDirty) await document.save();
  const folder = vscode.workspace.getWorkspaceFolder(document.uri);
  if (!folder) return fail('Open the repository folder that contains this flow first');
  const generated = await generateFlow(document, deps.schema);
  if (!generated.ok || !generated.result) return fail(generated.error ?? 'Code generation failed');
  const doc = parseFlow(document.getText()).doc;
  if (!doc) return fail('The flow does not parse');
  const name = doc.flow.runtime?.template;
  if (!name) return fail('The flow has no AWX job template: run "Set Up AWX Template" first');
  const awx = await awxClient(document.uri, deps.secrets);
  if (typeof awx === 'string') return fail(awx);

  const workflow = doc.flow.runtime?.kind === 'awx_workflow';
  const segments = generated.result.segments;
  if (workflow && !segments)
    return fail('The flow has no approvals to split any more: run "Set Up AWX Template" again');
  if (!workflow && segments)
    return fail('The flow has approvals: run "Set Up AWX Template" to create its AWX workflow');
  let template: AwxNamed | undefined;
  try {
    template = await awx.named<AwxNamed>(
      workflow ? 'workflow_job_templates' : 'job_templates',
      name,
    );
  } catch (e) {
    return fail((e as Error).message);
  }
  if (!template)
    return fail(
      `AWX has no ${workflow ? 'workflow' : 'job'} template "${name}": run "Set Up AWX Template"`,
    );
  const inputs = await collectInputs(doc, options.inputs, deps.state);
  if (!inputs) return fail('Cancelled');
  const targets = targetsOf(doc, inputs);
  if (targets.length === 0) return fail('No target hosts: the targets input is empty');

  const flowDir = relativeTo(folder.uri, vscode.Uri.joinPath(document.uri, '..'));
  const git = await gitState(folder.uri, (p) => p.startsWith(`${flowDir}/`));
  // Nodes with an inventory_target run there, in AWX's inventory (AFD-14).
  const uses = targetUses(buildModel(doc));
  if (!(deps.testMode && options.yes)) {
    const detail = [
      'AWX runs the flow for real (not check mode) with its own inventory and credentials.',
      `Template: ${name} (${awx.base})`,
      `Targets: ${targets.length} (${targets.slice(0, 8).join(', ')}${targets.length > 8 ? ', …' : ''})`,
      ...uses.map(
        (u) =>
          `Also on inventory_target ${resolvePattern(u.target, inputs) ?? u.target} (${u.nodes.map((k) => `[${k}]`).join(', ')}), in AWX's inventory`,
      ),
      ...(segments ?? [])
        .filter((s) => s.gate)
        .map((s) => {
          const gate = buildModel(doc).nodes.get(s.gate as string)?.node;
          return `Approval in AWX: [${gate?.key}] ${gate?.title} (approve, deny or let it time out)`;
        }),
      git?.dirty.length
        ? `Uncommitted changes: ${git.dirty.slice(0, 4).join(', ')}. AWX runs the last pushed commit.`
        : `Commit: ${git?.commit ?? 'unknown'}. Push it so AWX runs the same code.`,
    ];
    const go = 'Launch in AWX';
    const choice = await vscode.window.showWarningMessage(
      `Launch "${doc.flow.name}" in AWX?`,
      { modal: true, detail: detail.join('\n') },
      go,
    );
    if (choice !== go) return fail('Cancelled');
  }

  if (workflow && segments) {
    const audited = {
      run: id,
      user: await authorName(document.uri),
      flow: {
        id: doc.flow.id,
        key: doc.flow.key,
        version: doc.flow.version,
        file: vscode.workspace.asRelativePath(document.uri),
      },
      mode: 'real',
      source: 'awx',
      awx: { url: awx.base, workflow: name },
      hosts: targets.length,
      targets: uses,
    };
    await appendAudit(deps.storage, { event: 'launch', ...audited });
    const base = {
      id,
      mode: 'real' as const,
      startedAt,
      source: 'awx' as const,
      flowVersion: doc.flow.version,
      design: nodeDesigns(doc),
      environment: `AWX workflow: ${name}`,
    };
    deps.report({ ...base, state: 'running' });
    let end: Awaited<ReturnType<typeof runWorkflow>>;
    try {
      end = await runWorkflow(
        {
          awx,
          doc,
          segments,
          routes: generated.result.routes,
          sha: git?.sha,
          update: (s) =>
            deps.report({ ...base, state: 'running', awx: s.info, summary: s.summary }),
        },
        template.id,
        inputs,
      );
    } catch (e) {
      const run: RunView = { ...base, state: 'error', error: (e as Error).message };
      deps.report(run);
      return run;
    }
    const failedRun = end.workflow.status === 'error' || end.workflow.status === 'canceled';
    const final: RunView = {
      ...base,
      state: failedRun ? 'error' : 'done',
      awx: end.info,
      summary: end.summary,
      finishedAt: end.workflow.finished ?? new Date().toISOString(),
      rc: end.workflow.status === 'successful' ? 0 : 2,
      ...(failedRun
        ? { error: end.workflow.job_explanation || `AWX workflow ${end.workflow.status}` }
        : {}),
    };
    await appendAudit(deps.storage, {
      event: 'finish',
      run: id,
      source: 'awx',
      job: end.workflow.id,
      status: end.workflow.status,
      hosts: final.summary?.hosts.length ?? 0,
    });
    deps.report(final);
    if (final.awx?.revisionMismatch)
      void vscode.window.showWarningMessage(
        `AWX ran commit ${final.awx.revision?.slice(0, 7)}, not your HEAD ${git?.commit}: push your changes to the AWX project's remote.`,
      );
    return final;
  }

  let job: AwxJob;
  try {
    job = await awx.launch(template.id, inputs);
  } catch (e) {
    return fail((e as Error).message);
  }
  const audit = {
    run: id,
    user: await authorName(document.uri),
    flow: {
      id: doc.flow.id,
      key: doc.flow.key,
      version: doc.flow.version,
      file: vscode.workspace.asRelativePath(document.uri),
    },
    mode: 'real',
    source: 'awx',
    awx: { url: awx.base, template: name, job: job.id },
    hosts: targets.length,
    targets: uses,
  };
  await appendAudit(deps.storage, { event: 'launch', ...audit });

  const plays = playNodes(doc);
  const design = nodeDesigns(doc);
  const routes = generated.result.routes;
  const info = () => ({
    jobId: job.id,
    url: awx.jobUrl(job.id),
    template: name,
    status: job.status,
    revision: job.scm_revision || undefined,
    revisionMismatch: !!(job.scm_revision && git?.sha && job.scm_revision !== git.sha),
  });
  const events: AwxJobEvent[] = [];
  const view = (state: RunView['state']): RunView => ({
    id,
    mode: 'real',
    state,
    startedAt,
    source: 'awx',
    flowVersion: doc.flow.version,
    design,
    environment: `AWX: ${name}`,
    awx: info(),
    summary: summarizeRun(awxEventsToLines(events, plays), routes),
    ...(state === 'done'
      ? {
          finishedAt: job.finished ?? new Date().toISOString(),
          rc: job.status === 'successful' ? 0 : 2,
        }
      : {}),
    ...(state === 'error' ? { error: job.job_explanation || `AWX job ${job.status}` } : {}),
  });
  deps.report(view('running'));
  let ended: number | undefined;
  for (;;) {
    await new Promise((r) => setTimeout(r, POLL_MS));
    try {
      job = await awx.job(job.id);
      const fresh = await awx.events(job.id, events.at(-1)?.counter ?? 0);
      events.push(...fresh);
      const finished = FINISHED.has(job.status);
      if (finished) ended ??= Date.now();
      const complete = (job as AwxJob & { event_processing_finished?: boolean })
        .event_processing_finished;
      if (finished && (complete || Date.now() - (ended ?? 0) > EVENTS_GRACE_MS)) break;
      if (fresh.length > 0) deps.report(view('running'));
    } catch (e) {
      // A dropped tunnel or a restarting AWX: keep the last state and say why.
      const run = { ...view('error'), error: (e as Error).message };
      deps.report(run);
      return run;
    }
  }
  // AWX stores a running job's events out of counter order, so polling `counter__gt` can skip
  // one that lands late: read them all once more now that the job ended.
  try {
    events.splice(0, events.length, ...(await awx.events(job.id, 0)));
  } catch {
    // Keep what was polled; the summary may then miss a late event.
  }
  const final = view(job.status === 'error' || job.status === 'canceled' ? 'error' : 'done');
  await appendAudit(deps.storage, {
    event: 'finish',
    run: id,
    source: 'awx',
    job: job.id,
    status: job.status,
    hosts: final.summary?.hosts.length ?? 0,
  });
  deps.report(final);
  if (final.awx?.revisionMismatch)
    void vscode.window.showWarningMessage(
      `AWX ran commit ${final.awx.revision?.slice(0, 7)}, not your HEAD ${git?.commit}: push your changes to the AWX project's remote.`,
    );
  return final;
}

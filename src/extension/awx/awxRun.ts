// Run in AWX (M7, ADR-0013): the flow's job template, launched with the flow inputs as extra vars,
// followed through its job events and mapped back to nodes like local runs. AWX's RBAC and
// activity stream are the audit of record (decision 18); the local audit log records the launch.
// The token lives in SecretStorage only.
import * as vscode from 'vscode';
import { awxEventsToLines, playNodes } from '../../core/awx/events';
import { launchVars, surveyAction, surveyFor } from '../../core/awx/survey';
import {
  type AwxJob,
  type AwxJobEvent,
  type AwxJobTemplate,
  type AwxNamed,
  FINISHED,
} from '../../core/awx/types';
import { engineFor } from '../../core/engine/engines';
import { resolvePattern, targetUses } from '../../core/engine/targets';
import type { FlowCommand } from '../../core/flow/commands';
import { parseFlow } from '../../core/flow/document';
import { flowFileKey } from '../../core/flow/ids';
import { formatOf } from '../../core/flow/migrate';
import { buildModel, modelOf } from '../../core/flow/model';
import type { SchemaValidator } from '../../core/flow/schema';
import { nodeDesigns } from '../../core/flow/semantic';
import { runtimeKind } from '../../core/flow/status';
import type { FlowDocument } from '../../core/flow/types';
import type { RunErrorCode, RunView } from '../../core/protocol';
import { summarizeRun } from '../../core/run/events';
import { runWorkflow, setupWorkflow } from '../../node/awx/awxWorkflow';
import { AwxClient, followLimit, StoppedFollowing } from '../../node/awx/client';
import { TIMEOUTS } from '../../node/timeouts';
import { generatedDir } from '../codegen';
import { CANCELLED } from '../errors';
import { gitState } from '../gitHead';
import { appendAudit } from '../run/audit';
import { collectInputs, targetsOf } from '../run/inputs';
import { auditHeader, prepareRun, stamp } from '../run/prepare';
import { runStarted } from '../run/stop';
import { relativeTo } from '../sync/codeSync';

/**
 * Follows a launched job or workflow under a cancellable notification (AFD-29). Cancelling, or the
 * follow limit, stops the polling only: the job keeps running in AWX.
 */
function following<T>(
  title: string,
  follow: (stop: () => 'cancelled' | 'timeout' | undefined) => Promise<T>,
): Promise<T> {
  return Promise.resolve(
    vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title, cancellable: true },
      (_progress, token) => follow(followLimit(() => token.isCancellationRequested)),
    ),
  );
}

/** After following stopped: the job still runs in AWX, so offer to cancel it there or open it. */
function offerCancel(awx: AwxClient, stopped: StoppedFollowing): void {
  const cancel = 'Cancel It in AWX';
  const open = 'Open in AWX';
  void vscode.window.showWarningMessage(stopped.message, cancel, open).then(async (pick) => {
    if (pick === open) await vscode.env.openExternal(vscode.Uri.parse(stopped.url));
    if (pick !== cancel) return;
    try {
      if (stopped.kind === 'job') await awx.cancel(stopped.id);
      else await awx.cancelWorkflow(stopped.id);
      void vscode.window.showInformationMessage(`AWX ${stopped.kind} ${stopped.id} was cancelled`);
    } catch (e) {
      void vscode.window.showErrorMessage((e as Error).message);
    }
  });
}

/** The runtime to record after Set Up AWX Template: format 2 keeps the template only (AFD-50). */
function runtimeFor(
  doc: FlowDocument,
  kind: 'awx_workflow' | 'awx_job',
  template: string,
  credentials: readonly AwxNamed[],
  ee: AwxNamed | undefined,
): NonNullable<FlowDocument['flow']['runtime']> {
  if (formatOf(doc) >= 2) {
    // Format 2 keeps what the template was set up with (AFD-52); the kind follows from the flow.
    const { kind: _kind, ...rest } = doc.flow.runtime ?? {};
    return {
      ...rest,
      template,
      ...(credentials.length ? { credentials: credentials.map((c) => c.name) } : {}),
      ...(ee ? { execution_environment: ee.name } : {}),
    };
  }
  return { ...doc.flow.runtime, kind, template };
}
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
  /** A survey changed in AWX: replace or keep it, without asking (tests). */
  survey?: 'replace' | 'keep';
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

/**
 * AFD-140: the flow decides which AWX template runs, with which extra vars, and (format 2) which
 * credentials and execution environment the template gets. In Restricted Mode the user-level AWX
 * address and token would still be used, so setting up and launching need a trusted workspace,
 * as local runs do. Importing from AWX only reads, and stays allowed.
 */
export const AWX_UNTRUSTED =
  'This workspace is not trusted, so Ansible Flow does not set up or launch AWX templates from its flows: trust the workspace first';

export async function awxClient(
  scope: vscode.Uri,
  secrets: vscode.SecretStorage,
): Promise<AwxClient | { error: string; code: RunErrorCode }> {
  const { url, verifyTls } = settings(scope);
  if (!url) return { error: 'Set afd.awx.url to the AWX address first', code: 'awx-url' };
  const token = await secrets.get(tokenKey(url));
  if (!token)
    return {
      error: `No AWX token for ${url}: run "Ansible Flow: Set AWX Token"`,
      code: 'awx-token',
    };
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
  while (Date.now() - t0 < TIMEOUTS.awxProjectSync) {
    const u = await awx.get<{ status: string }>(`/api/v2/project_updates/${update.id}/`);
    if (['successful', 'failed', 'error', 'canceled'].includes(u.status)) return u.status;
    await new Promise((r) => setTimeout(r, TIMEOUTS.awxPoll));
  }
  return 'timeout';
}

/**
 * "Set up AWX template" (decision M7-3): picks the AWX project, inventory, execution environment
 * and credentials, creates or updates the job template for the generated playbook, and writes
 * its name to flow.runtime (one edit).
 */
type SurveyOutcome = 'written' | 'same' | 'kept';

/**
 * The template's survey from the flow inputs (AFD-59): written where there is none or ours is as we
 * left it; a survey changed in AWX is replaced only when the user says so (`choice` in tests).
 */
async function applySurvey(
  awx: AwxClient,
  kind: 'job_templates' | 'workflow_job_templates',
  template: AwxNamed,
  doc: FlowDocument,
  choice?: 'replace' | 'keep',
): Promise<SurveyOutcome> {
  const wanted = surveyFor(doc);
  const action = surveyAction(await awx.survey(kind, template.id), wanted);
  if (action === 'same') return 'same';
  if (action === 'ask') {
    const replace = 'Replace Survey';
    const pick =
      choice === undefined
        ? await vscode.window.showWarningMessage(
            `The survey of ${template.name} was changed in AWX. Replace it with the flow's inputs?`,
            { modal: true, detail: 'Keep it to leave the questions as they are in AWX.' },
            replace,
            'Keep It',
          )
        : choice === 'replace'
          ? replace
          : undefined;
    if (pick !== replace) return 'kept';
  }
  await awx.setSurvey(kind, template.id, wanted);
  return 'written';
}

export async function setupTemplate(
  document: vscode.TextDocument,
  deps: AwxDeps,
  picks?: AwxPicks,
): Promise<{ ok: boolean; error?: string; template?: string; survey?: SurveyOutcome }> {
  if (!vscode.workspace.isTrusted) return { ok: false, error: AWX_UNTRUSTED };
  const doc = parseFlow(document.getText()).doc;
  const folder = vscode.workspace.getWorkspaceFolder(document.uri);
  if (!doc || !folder)
    return { ok: false, error: 'Open a valid flow inside its repository folder' };
  const awx = await awxClient(document.uri, deps.secrets);
  if ('error' in awx) return { ok: false, error: awx.error };
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
    // Format 2 (AFD-52): what the flow names is what the template gets; the rest is asked.
    const named = formatOf(doc) >= 2 ? doc.flow.runtime : undefined;
    const ees = await awx.list<AwxNamed>('execution_environments');
    const wantEe = picks?.environment ?? named?.execution_environment;
    const ee =
      picks || wantEe
        ? wantEe
          ? (ees.find((e) => e.name === wantEe) ?? null)
          : undefined
        : await pick(ees, 'Execution environment (ansible-core 2.19+)', undefined, true);
    if (ee === null)
      return {
        ok: false,
        error: wantEe ? `No AWX execution environment ${wantEe}` : 'Cancelled',
      };
    let credentials: AwxNamed[] = [];
    const all = await awx.list<AwxNamed>('credentials');
    const wantCreds = picks?.credentials ?? named?.credentials;
    if (picks || wantCreds?.length) {
      credentials = all.filter((c) => wantCreds?.includes(c.name));
      const missing = (wantCreds ?? []).filter((n) => !credentials.some((c) => c.name === n));
      if (missing.length) return { ok: false, error: `No AWX credential ${missing.join(', ')}` };
      // AFD-140: credentials the flow file names are attached only once the user agrees.
      if (!picks && credentials.length) {
        const attach = 'Attach Credentials';
        const go = await vscode.window.showWarningMessage(
          `The flow asks for the AWX credentials ${credentials.map((c) => `"${c.name}"`).join(', ')} on its template. Attach them?`,
          { modal: true, detail: 'They come from flow.runtime.credentials in the flow file.' },
          attach,
        );
        if (go !== attach) return { ok: false, error: 'Cancelled' };
      }
    } else {
      const chosen = await vscode.window.showQuickPick(
        all.map((c) => ({ label: c.name, item: c })),
        { title: 'Credentials (machine, vault …)', canPickMany: true, ignoreFocusOut: true },
      );
      if (!chosen) return { ok: false, error: 'Cancelled' };
      credentials = chosen.map((c) => c.item);
    }
    // Top-level approvals: an AWX workflow of segment playbooks (AFD-11, ADR-0016).
    const plan = engineFor(doc).generate(doc, { source: document.uri.path.split('/').pop() ?? '' });
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
      const workflow = await awx.named<AwxNamed>('workflow_job_templates', name);
      const survey = workflow
        ? await applySurvey(
            awx,
            'workflow_job_templates',
            workflow,
            doc,
            picks ? (picks.survey ?? 'keep') : undefined,
          )
        : undefined;
      const runtime = runtimeFor(doc, 'awx_workflow', name, credentials, ee ?? undefined);
      if (JSON.stringify(runtime) !== JSON.stringify(doc.flow.runtime ?? {})) {
        const r = await deps.runCommand({ kind: 'updateFlow', patch: { runtime } });
        if (!r.ok) return { ok: false, error: r.error };
      }
      return { ok: true, template: name, survey };
    }
    const playbook = relativeTo(
      folder.uri,
      vscode.Uri.joinPath(generatedDir(document.uri), `${flowFileKey(doc.flow.key)}.yml`),
    );
    const missing = await missingPlaybooks(awx, project, [playbook]);
    if (missing) return { ok: false, error: missing };
    const name = templateName(doc);
    // AFD-140: a template of that name made for another project or playbook (another flow with
    // the same key) is changed only once the user agrees.
    const existing = await awx.named<AwxJobTemplate>('job_templates', name);
    if (!picks && existing && (existing.project !== project.id || existing.playbook !== playbook)) {
      const update = 'Update Template';
      const go = await vscode.window.showWarningMessage(
        `AWX already has a job template "${name}" that runs ${existing.playbook || 'another playbook'}. Point it at this flow's ${playbook}?`,
        { modal: true, detail: 'Another flow with the same key may use it.' },
        update,
      );
      if (go !== update) return { ok: false, error: 'Cancelled' };
    }
    const jt = await awx.upsertTemplate({
      name,
      description: `Ansible Flow Designer: ${doc.flow.name} (${doc.flow.key}), generated playbook`,
      project: project.id,
      playbook,
      inventory: inventory.id,
      execution_environment: ee?.id,
      credentials: credentials.map((c) => c.id),
    });
    const survey = await applySurvey(
      awx,
      'job_templates',
      jt,
      doc,
      picks ? (picks.survey ?? 'keep') : undefined,
    );
    const runtime = runtimeFor(doc, 'awx_job', name, credentials, ee ?? undefined);
    if (JSON.stringify(runtime) !== JSON.stringify(doc.flow.runtime ?? {})) {
      const r = await deps.runCommand({ kind: 'updateFlow', patch: { runtime } });
      if (!r.ok) return { ok: false, error: r.error };
    }
    return { ok: true, template: name, survey };
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
  const fail = (error: string, errorCode?: RunErrorCode): RunView => {
    const run: RunView = {
      id,
      mode: 'real',
      state: 'error',
      startedAt,
      error,
      source: 'awx',
      ...(errorCode ? { errorCode } : {}),
    };
    deps.report(run);
    return run;
  };
  const prepared = await prepareRun(document, deps.schema);
  if (!prepared.ok) return fail(prepared.error);
  const { folder, generated, doc } = prepared;
  const name = doc.flow.runtime?.template;
  if (!name)
    return fail(
      'The flow has no AWX job template: run "Set Up AWX Template" first',
      'awx-template',
    );
  if (!vscode.workspace.isTrusted) return fail(AWX_UNTRUSTED, 'environment');
  const awx = await awxClient(document.uri, deps.secrets);
  if ('error' in awx) return fail(awx.error, awx.code);

  const workflow = runtimeKind(modelOf(doc)) === 'awx_workflow';
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
  if (!inputs) return fail(CANCELLED, 'cancelled');
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
    if (choice !== go) return fail(CANCELLED, 'cancelled');
  }

  if (workflow && segments) {
    const audited = {
      run: id,
      ...(await auditHeader(document, doc)),
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
    const routes = generated.result.routes;
    // Stop Run (AFD-39) cancels the workflow in AWX; following then ends with it.
    let stopping: vscode.Disposable | undefined;
    let end: Awaited<ReturnType<typeof runWorkflow>>;
    try {
      end = await following(`Following AWX workflow ${name}`, (stop) =>
        runWorkflow(
          {
            awx,
            doc,
            segments,
            routes,
            sha: git?.sha,
            stop,
            launched: (workflowJob) => {
              stopping = runStarted(document.uri, () => awx.cancelWorkflow(workflowJob));
            },
            update: (s) =>
              deps.report({ ...base, state: 'running', awx: s.info, summary: s.summary }),
          },
          template.id,
          launchVars(doc, inputs),
        ),
      );
    } catch (e) {
      stopping?.dispose();
      if (e instanceof StoppedFollowing) offerCancel(awx, e);
      const run: RunView = { ...base, state: 'error', error: (e as Error).message };
      deps.report(run);
      return run;
    }
    stopping?.dispose();
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
    // A survey takes a host list as text (AFD-59).
    job = await awx.launch(template.id, launchVars(doc, inputs));
  } catch (e) {
    return fail((e as Error).message);
  }
  // Stop Run (AFD-39) cancels the job in AWX; following then ends with it as canceled.
  const stopping = runStarted(document.uri, () => awx.cancel(job.id));
  const audit = {
    run: id,
    ...(await auditHeader(document, doc)),
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
  const stopped = await following(`Following AWX job ${job.id}`, async (stop) => {
    let ended: number | undefined;
    for (;;) {
      await new Promise((r) => setTimeout(r, TIMEOUTS.awxPoll));
      const why = stop();
      if (why) return new StoppedFollowing('job', job.id, awx.jobUrl(job.id), why === 'timeout');
      try {
        job = await awx.job(job.id);
        const fresh = await awx.events(job.id, events.at(-1)?.counter ?? 0);
        events.push(...fresh);
        const finished = FINISHED.has(job.status);
        if (finished) ended ??= Date.now();
        const complete = (job as AwxJob & { event_processing_finished?: boolean })
          .event_processing_finished;
        if (finished && (complete || Date.now() - (ended ?? 0) > TIMEOUTS.awxEventsGrace)) return;
        if (fresh.length > 0) deps.report(view('running'));
      } catch (e) {
        // A dropped tunnel or a restarting AWX: keep the last state and say why.
        return e as Error;
      }
    }
  });
  stopping.dispose();
  if (stopped) {
    if (stopped instanceof StoppedFollowing) offerCancel(awx, stopped);
    const run = { ...view('error'), error: stopped.message };
    deps.report(run);
    return run;
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

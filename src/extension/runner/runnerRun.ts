// Run on Ansible Flow Server (AFD-276): the flow's launch configuration on the server, launched
// with the flow inputs, followed until it ends and shown on the canvas like local runs. The server
// runs its own commit of the project (the configuration's, else the newest of its branch); the
// confirmation says which and warns when the local HEAD differs. The server's access levels and
// audit log are the record; the local audit log records the launch. The token lives in
// SecretStorage only.
import * as vscode from 'vscode';
import { formatOf } from '../../core/flow/migrate';
import { nodeDesigns } from '../../core/flow/semantic';
import type { RunApproval, RunErrorCode, RunView } from '../../core/protocol';
import { inputText } from '../../core/run/launch';
import { followLimit } from '../../node/awx/client';
import {
  type RunnerClient as Client,
  incompatible,
  RunnerClient,
  type RunnerConfig,
  RunnerError,
  type RunnerRun,
} from '../../node/runner/client';
import { TIMEOUTS } from '../../node/timeouts';
import type { AwxDeps } from '../awx/awxRun';
import { generatedDir } from '../codegen';
import { CANCELLED } from '../errors';
import { gitState, remoteUrls } from '../gitHead';
import { appendAudit } from '../run/audit';
import { collectInputs, targetsOf } from '../run/inputs';
import { auditHeader, prepareRun, stamp } from '../run/prepare';
import { runStarted } from '../run/stop';
import { relativeTo } from '../sync/codeSync';

export type RunnerDeps = Pick<
  AwxDeps,
  'secrets' | 'storage' | 'state' | 'schema' | 'testMode' | 'report'
>;

/** The user's own setting only (AFD-161): a repository must not weaken the token's transport. */
const userOnly = (c: vscode.WorkspaceConfiguration, key: string, fallback: boolean) =>
  c.inspect<boolean>(key)?.globalValue ?? fallback;

function settings(scope: vscode.Uri) {
  const c = vscode.workspace.getConfiguration('afd', scope);
  return {
    url: (c.get<string>('runner.url', '') ?? '').trim().replace(/\/+$/, ''),
    project: (c.get<string>('runner.project', '') ?? '').trim(),
    verifyTls: userOnly(c, 'runner.verifyTls', true),
    allowHttp: userOnly(c, 'runner.allowHttp', false),
  };
}

/** Whether an Ansible Flow Server is set up for this folder: the run menu offers it then. */
export const runnerConfigured = (scope: vscode.Uri) => !!settings(scope).url;

const tokenKey = (url: string) => `afd.runner.token:${url}`;
const configKey = (url: string, flowFile: string) => `afd.runner.config:${url}:${flowFile}`;

/** Like AWX launches (AFD-140): an untrusted repository does not launch on the user's server. */
export const RUNNER_UNTRUSTED =
  'This workspace is not trusted, so Ansible Flow does not run its flows on Ansible Flow Server: trust the workspace first';

const warnedTls = new Set<string>();

export async function runnerClient(
  scope: vscode.Uri,
  secrets: vscode.SecretStorage,
): Promise<Client | { error: string; code: RunErrorCode }> {
  const { url, verifyTls, allowHttp } = settings(scope);
  if (!url)
    return {
      error: 'Set afd.runner.url to the address of Ansible Flow Server first',
      code: 'runner-url',
    };
  try {
    new URL(url);
  } catch {
    return { error: `afd.runner.url is not an address: ${url}`, code: 'runner-url' };
  }
  if (!verifyTls && !warnedTls.has(url)) {
    warnedTls.add(url);
    void vscode.window.showWarningMessage(
      `TLS verification for ${url} is off (afd.runner.verifyTls): the token goes to whoever answers there. Use this for a lab server only.`,
    );
  }
  const token = await secrets.get(tokenKey(url));
  if (!token)
    return {
      error: `No access token for ${url}: run "Ansible Flow: Set Server Token"`,
      code: 'runner-token',
    };
  return new RunnerClient(url, token, { verifyTls, allowHttp });
}

/** Stores a token for the configured server after checking it (never shown or logged again). */
export async function setRunnerToken(
  scope: vscode.Uri,
  secrets: vscode.SecretStorage,
  given?: string,
): Promise<string | undefined> {
  const { url, verifyTls, allowHttp } = settings(scope);
  if (!url) return 'Set afd.runner.url to the address of Ansible Flow Server first';
  const token =
    given ??
    (await vscode.window.showInputBox({
      title: `Access token for ${url}`,
      prompt: 'A personal access token (My account on the server); stored in VS Code SecretStorage',
      password: true,
      ignoreFocusOut: true,
    }));
  if (!token) return CANCELLED;
  try {
    const me = await new RunnerClient(url, token.trim(), { verifyTls, allowHttp }).me();
    await secrets.store(tokenKey(url), token.trim());
    if (!given)
      void vscode.window.showInformationMessage(`Token stored for ${me.login} at ${url}.`);
    return undefined;
  } catch (e) {
    return (e as Error).message;
  }
}

export async function clearRunnerToken(
  scope: vscode.Uri,
  secrets: vscode.SecretStorage,
): Promise<void> {
  const { url } = settings(scope);
  if (url) await secrets.delete(tokenKey(url));
}

/**
 * The server's project for the repository: the one whose git address is a remote of it, else
 * afd.runner.project (`<workspace>/<project>`).
 */
async function projectOf(
  client: Client,
  folder: vscode.Uri,
): Promise<{ id: string; workspace: string; key: string; commit?: string } | undefined> {
  const host = new URL(client.base).host;
  let named = settings(folder).project;
  for (const remote of await remoteUrls(folder)) {
    let u: URL;
    try {
      u = new URL(remote);
    } catch {
      continue;
    }
    const m = /\/git\/([^/]+)\/([^/]+?)(\.git)?\/?$/.exec(u.pathname);
    if (u.host === host && m) {
      named = `${m[1]}/${m[2]}`;
      break;
    }
  }
  const [workspace, key] = named.split('/');
  if (!workspace || !key) return undefined;
  const project = (await client.projects(workspace)).find((p) => p.key === key);
  return project ? { id: project.id, workspace, key, commit: project.commit } : undefined;
}

/** The launch configuration of this flow: the remembered one, the only one, or the one picked. */
async function configOf(
  client: Client,
  project: string,
  flowFile: string,
  state: vscode.Memento,
  named?: string,
): Promise<RunnerConfig | undefined | null> {
  const all = (await client.configs(project)).filter((c) => c.flowFile === flowFile);
  if (named) return all.find((c) => c.name === named || c.id === named) ?? null;
  const remembered = all.find((c) => c.id === state.get<string>(configKey(client.base, flowFile)));
  if (remembered) return remembered;
  if (all.length <= 1) return all[0] ?? null;
  const pick = await vscode.window.showQuickPick(
    all.map((c) => ({
      label: c.name,
      description: `${c.mode}${c.inventory ? `, ${c.inventory}` : ''}`,
      config: c,
    })),
    { title: `Launch configuration on ${client.base}`, ignoreFocusOut: true },
  );
  if (!pick) return undefined;
  await state.update(configKey(client.base, flowFile), pick.config.id);
  return pick.config;
}

const ENDED = new Set(['succeeded', 'failed', 'cancelled', 'lost']);

/** A run on the server as the canvas shows it. */
function viewOf(
  base: Pick<RunView, 'id' | 'mode' | 'startedAt' | 'flowVersion' | 'design'>,
  run: RunnerRun,
  info: { url: string; config: string; drift?: string },
  served: Record<string, unknown> | undefined,
  mayDecide: Set<string>,
): RunView {
  const approvals = served?.approvals as Record<string, RunApproval> | undefined;
  const ended = ENDED.has(run.state);
  // A run whose hosts failed shows as a local one does (done, rc 2); one that did not run is an error.
  const failed = run.state !== 'succeeded' && !(run.state === 'failed' && served?.summary);
  return {
    ...base,
    state: !ended ? 'running' : failed ? 'error' : 'done',
    source: 'runner',
    environment: `Ansible Flow Server: ${info.config}`,
    runner: {
      runId: run.id,
      number: run.number,
      url: info.url,
      state: run.state,
      commit: run.commit,
      config: info.config,
      ...(info.drift ? { drift: info.drift } : {}),
    },
    ...(served?.summary ? { summary: served.summary as RunView['summary'] } : {}),
    ...(approvals
      ? {
          approvals: Object.fromEntries(
            Object.entries(approvals).map(([node, a]) => [
              node,
              { ...a, url: info.url, ...(mayDecide.has(node) ? { mayDecide: true } : {}) },
            ]),
          ),
        }
      : {}),
    ...(ended
      ? {
          finishedAt: run.endedAt ?? new Date().toISOString(),
          rc: run.state === 'succeeded' ? 0 : 2,
          ...(failed ? { error: run.error ?? `The run ${run.state} on the server` } : {}),
        }
      : {}),
  };
}

/** Run on Server: inputs, what would run, a confirmation, the run, then its state until it ends. */
export async function launchOnServer(
  document: vscode.TextDocument,
  deps: RunnerDeps,
  options: {
    inputs?: Record<string, unknown>;
    yes?: boolean;
    mode?: 'check' | 'real';
    config?: string;
  } = {},
): Promise<RunView> {
  const id = stamp();
  const startedAt = new Date().toISOString();
  const fail = (
    error: string,
    errorCode?: RunErrorCode,
    mode: 'check' | 'real' = 'real',
  ): RunView => {
    const run: RunView = {
      id,
      mode,
      state: 'error',
      startedAt,
      error,
      source: 'runner',
      ...(errorCode ? { errorCode } : {}),
    };
    deps.report(run);
    return run;
  };
  const prepared = await prepareRun(document, deps.schema);
  if (!prepared.ok) return fail(prepared.error);
  const { folder, doc } = prepared;
  if (!vscode.workspace.isTrusted) return fail(RUNNER_UNTRUSTED, 'environment');
  const client = await runnerClient(document.uri, deps.secrets);
  if ('error' in client) return fail(client.error, client.code);

  const flowFile = relativeTo(folder.uri, document.uri);
  let config: RunnerConfig;
  try {
    const why = incompatible(await client.meta(), formatOf(doc));
    if (why) return fail(why);
    const project = await projectOf(client, folder.uri);
    if (!project)
      return fail(
        `Ansible Flow Server ${client.base} has no project for this repository: clone it from the server, or set afd.runner.project to <workspace>/<project>`,
        'runner-project',
      );
    const found = await configOf(client, project.id, flowFile, deps.state, options.config);
    if (found === undefined) return fail(CANCELLED, 'cancelled');
    if (found === null)
      return fail(
        `The project ${project.workspace}/${project.key} has no launch configuration for ${flowFile}: someone with edit access adds one on the server`,
        'runner-project',
      );
    config = found;
  } catch (e) {
    return fail((e as Error).message);
  }

  const inputs = await collectInputs(doc, options.inputs, deps.state);
  if (!inputs) return fail(CANCELLED, 'cancelled');
  if (targetsOf(doc, inputs).length === 0)
    return fail('No target hosts: the targets input is empty');
  const asText = Object.fromEntries(Object.entries(inputs).map(([k, v]) => [k, inputText(v)]));

  // What the server would run; its problems are the server's words, by input.
  let mode = options.mode ?? config.mode;
  let launch: Awaited<ReturnType<Client['check']>>;
  try {
    launch = await client.check(config.id, { mode, inputs: asText });
  } catch (e) {
    const problems = e instanceof RunnerError ? (e.problems ?? []) : [];
    return fail(
      problems.length
        ? problems.map((p) => (p.field ? `${p.field}: ${p.message}` : p.message)).join('; ')
        : (e as Error).message,
      undefined,
      mode,
    );
  }
  const flowDir = relativeTo(folder.uri, vscode.Uri.joinPath(document.uri, '..'));
  // The server generates the flow's code itself: generated files are not what it misses.
  const generatedPath = relativeTo(folder.uri, generatedDir(document.uri));
  const git = await gitState(
    folder.uri,
    (p) => (p.startsWith(`${flowDir}/`) || p === flowFile) && !p.startsWith(`${generatedPath}/`),
  );
  const drift = git?.dirty.length
    ? `Uncommitted changes (${git.dirty.slice(0, 4).join(', ')}): the server runs ${launch.commit.slice(0, 7)}, without them`
    : git?.sha && git.sha !== launch.commit
      ? `The server runs ${launch.commit.slice(0, 7)}, not your HEAD ${git.commit}: push your work so the server runs it`
      : undefined;

  if (!(deps.testMode && options.yes)) {
    const detail = [
      `Server: ${client.base}`,
      `Launch configuration: ${config.name}`,
      `Commit: ${launch.commit.slice(0, 12)}${launch.ref ? ` (newest of ${launch.ref})` : ''}`,
      `Targets: ${launch.targets.length} (${launch.targets.slice(0, 8).join(', ')}${launch.targets.length > 8 ? ', …' : ''})`,
      ...(launch.inventory ? [`Inventory: ${launch.inventory}`] : []),
      ...(drift ? [drift] : []),
    ];
    const check = 'Check on Server';
    const real = 'Run for Real on Server';
    const choice = await vscode.window.showWarningMessage(
      `Run "${doc.flow.name}" on Ansible Flow Server?`,
      { modal: true, detail: detail.join('\n') },
      ...(mode === 'real' ? [real, check] : [check, real]),
    );
    if (!choice) return fail(CANCELLED, 'cancelled', mode);
    mode = choice === real ? 'real' : 'check';
  }

  let run: RunnerRun;
  try {
    run = await client.launch(config.id, { mode, inputs: asText });
  } catch (e) {
    return fail((e as Error).message, undefined, mode);
  }
  const url = client.runUrl(run.id);
  await appendAudit(deps.storage, {
    event: 'launch',
    run: id,
    ...(await auditHeader(document, doc)),
    mode,
    source: 'runner',
    runner: {
      url: client.base,
      config: config.name,
      run: run.id,
      number: run.number,
      commit: run.commit,
    },
    hosts: launch.targets.length,
  });
  const base = { id, mode, startedAt, flowVersion: doc.flow.version, design: nodeDesigns(doc) };
  const info = { url, config: config.name, ...(drift ? { drift } : {}) };
  deps.report(viewOf(base, run, info, undefined, new Set()));
  // Stop Run (AFD-39) stops it on the server; following then ends with it.
  const stopping = runStarted(document.uri, async () => {
    await client.cancel(run.id);
  });

  let last = viewOf(base, run, info, undefined, new Set());
  const outcome = await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `Following run ${run.number} on Ansible Flow Server`,
      cancellable: true,
    },
    async (_progress, token) => {
      const stop = followLimit(() => token.isCancellationRequested);
      for (;;) {
        const why = stop();
        if (why) return why;
        try {
          run = await client.run(run.id);
          const served = await client.view(run.id);
          const gates = run.state === 'waiting' ? await client.gates(run.id) : [];
          const mayDecide = new Set(gates.filter((g) => g.mayDecide).map((g) => g.node.id));
          last = viewOf(base, run, info, served, mayDecide);
          deps.report(last);
          if (ENDED.has(run.state)) return 'ended';
        } catch (e) {
          // A dropped connection or a restarting server: keep the last state and say why.
          return e as Error;
        }
        await new Promise((r) => setTimeout(r, TIMEOUTS.runnerPoll));
      }
    },
  );
  stopping.dispose();
  if (outcome !== 'ended') {
    const message =
      outcome instanceof Error
        ? `Stopped following run ${run.number}: ${outcome.message}. It goes on on the server.`
        : `Stopped following run ${run.number}; it goes on on the server.`;
    const open = 'Open on Server';
    void vscode.window.showWarningMessage(message, open).then((pick) => {
      if (pick === open) void vscode.env.openExternal(vscode.Uri.parse(url));
    });
    const view: RunView = { ...last, state: 'error', error: message };
    deps.report(view);
    return view;
  }
  await appendAudit(deps.storage, {
    event: 'finish',
    run: id,
    source: 'runner',
    runner: { run: run.id, state: run.state },
    hosts: last.summary?.hosts.length ?? 0,
  });
  if (drift && run.state !== 'cancelled') void vscode.window.showWarningMessage(drift);
  return last;
}

/** Decides an approval of a run on the server, as the user (the server says whether they may). */
export async function decideOnServer(
  scope: vscode.Uri,
  secrets: vscode.SecretStorage,
  runId: string,
  node: string,
  decision: 'approved' | 'rejected',
  comment?: string,
): Promise<string | undefined> {
  const client = await runnerClient(scope, secrets);
  if ('error' in client) return client.error;
  try {
    await client.decide(runId, node, decision, comment);
    return undefined;
  } catch (e) {
    return (e as Error).message;
  }
}

/** What one host did in one step of a run on the server. */
export async function serverHostOutput(
  scope: vscode.Uri,
  secrets: vscode.SecretStorage,
  runId: string,
  node: string,
  host: string,
): Promise<{ entries?: unknown[]; error?: string }> {
  const client = await runnerClient(scope, secrets);
  if ('error' in client) return { error: client.error };
  try {
    return { entries: (await client.hostOutput(runId, node, host)).entries ?? [] };
  } catch (e) {
    return { error: (e as Error).message };
  }
}

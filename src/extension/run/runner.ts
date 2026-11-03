// Run as skeleton (check mode) and local real runs (decision 18, ADR-0009): regenerate, ask for the
// flow inputs, confirm real runs with inventory facts, prompt for the vault password per run, run
// ansible-playbook in a terminal task, audit the launch, and map the events back to nodes.
import { existsSync } from 'node:fs';
import * as vscode from 'vscode';
import { resolvePattern, targetUses } from '../../core/engine/targets';
import { buildModel } from '../../core/flow/model';
import type { SchemaValidator } from '../../core/flow/schema';
import { nodeDesigns } from '../../core/flow/semantic';
import type { FlowDocument } from '../../core/flow/types';
import type { RunErrorCode, RunView } from '../../core/protocol';
import { runProcess, splitInputs } from '../../core/run/command';
import { summarizeRun } from '../../core/run/events';
import { dropVars, KEEP_RUNS, pruneRuns } from '../../node/run/storage';
import { TIMEOUTS } from '../../node/timeouts';
import { environmentFor, type ProbeManager } from '../env/environment';
import { showEnvironmentError } from '../env/setupEnvironment';
import { CANCELLED } from '../errors';
import { appendAudit } from './audit';
import { collectInputs, targetsOf } from './inputs';
import { auditHeader, prepareRun, stamp } from './prepare';
import { runStarted } from './stop';

export interface RunOptions {
  mode: 'check' | 'real';
  /** Flow input values; prompted for when missing. */
  inputs?: Record<string, unknown>;
  /** Test mode only: answer the real-run confirmation with yes. */
  yes?: boolean;
}

export interface RunDeps {
  schema: SchemaValidator;
  probes: ProbeManager;
  probeDir: string;
  storage: vscode.Uri;
  state: vscode.Memento;
  testMode: boolean;
  report: (run: RunView) => void;
}

interface InventoryFacts {
  sources: string[];
  count: number;
  hosts: string[];
  unknown: string[];
  prod_groups: string[];
  prod_hosts: string[];
  vault: boolean;
}

/** A target the run touches beyond the flow targets: nodes with an inventory_target (AFD-14). */
export interface TargetUse {
  /** The pattern with flow inputs filled in; undefined when it needs Jinja beyond that. */
  pattern?: string;
  declared: string;
  nodes: string[];
  count?: number;
  prod: string[];
}

async function targetFacts(
  doc: FlowDocument,
  inputs: Record<string, unknown>,
  count: (pattern: string) => Promise<InventoryFacts>,
): Promise<TargetUse[]> {
  return Promise.all(
    targetUses(buildModel(doc)).map(async (u): Promise<TargetUse> => {
      const pattern = resolvePattern(u.target, inputs);
      const use: TargetUse = { pattern, declared: u.target, nodes: u.nodes, prod: [] };
      if (!pattern) return use;
      try {
        const f = await count(pattern);
        use.count = f.count;
        use.prod = [...f.prod_groups, ...f.prod_hosts];
      } catch {
        // Counted at run time only; the confirmation says so.
      }
      return use;
    }),
  );
}

/** Confirmation lines for the targets: pattern, host count and the nodes that run there. */
export function targetLines(uses: TargetUse[]): string[] {
  return uses.map((u) => {
    const where = u.nodes.map((k) => `[${k}]`).join(', ');
    const hosts =
      u.count === undefined
        ? 'resolved at run time'
        : u.count === 0
          ? 'matches no host, so those nodes fail every arriving host'
          : `${u.count} host(s)`;
    return `Also on inventory_target ${u.pattern ?? u.declared}: ${hosts} (${where})`;
  });
}

export async function runFlow(
  document: vscode.TextDocument,
  deps: RunDeps,
  options: RunOptions,
): Promise<RunView> {
  const startedAt = new Date().toISOString();
  const id = stamp();
  const fail = (error: string, errorCode?: RunErrorCode): RunView => {
    const run: RunView = {
      id,
      mode: options.mode,
      state: 'error',
      startedAt,
      error,
      ...(errorCode ? { errorCode } : {}),
    };
    deps.report(run);
    return run;
  };

  const prepared = await prepareRun(document, deps.schema, { refuseKept: true });
  if (!prepared.ok) return fail(prepared.error);
  const { folder, generated, doc } = prepared;
  if (!generated.dir) return fail('Code generation failed');

  const env = environmentFor(folder.uri);
  if (!env.ok) {
    showEnvironmentError(env.error, () => runFlow(document, deps, options));
    return fail(env.error, 'environment');
  }
  const inputs = await collectInputs(doc, options.inputs, deps.state, options.mode === 'check');
  if (!inputs) return fail(CANCELLED, 'cancelled');
  const targets = targetsOf(doc, inputs);
  if (targets.length === 0) return fail('No target hosts: the targets input is empty');

  const config = vscode.workspace.getConfiguration('afd', document.uri);
  const inventory = config.get<string>('run.inventory', '') || undefined;
  const probe = deps.probes.forFolder(folder.uri);
  if ('error' in probe) return fail(probe.error);
  let facts: InventoryFacts;
  try {
    facts = await probe.client.call<InventoryFacts>(
      'inventory',
      { inventory, targets },
      TIMEOUTS.probeInventory,
    );
  } catch (e) {
    return fail(`The Ansible environment (${probe.label}) did not answer: ${(e as Error).message}`);
  }
  if (facts.count === 0)
    return fail(`None of the targets (${targets.join(', ')}) is in the inventory`);
  const uses = await targetFacts(doc, inputs, (pattern) =>
    probe.client.call<InventoryFacts>(
      'inventory',
      { inventory, targets: [pattern] },
      TIMEOUTS.probeInventory,
    ),
  );
  const prod = [
    ...new Set([...facts.prod_groups, ...facts.prod_hosts, ...uses.flatMap((u) => u.prod)]),
  ];
  const extra = uses.reduce((n, u) => n + (u.count ?? 0), 0);

  if (options.mode === 'real' && !(deps.testMode && options.yes)) {
    const shown = facts.hosts.slice(0, 8).join(', ') + (facts.count > 8 ? ', …' : '');
    const detail = [
      'This is not check mode: bound nodes change the devices.',
      `Inventory: ${facts.sources.join(', ')}`,
      `Hosts: ${facts.count} (${shown})`,
      facts.unknown.length ? `Not in the inventory: ${facts.unknown.join(', ')}` : '',
      ...targetLines(uses),
      prod.length
        ? `Production-looking: ${prod.slice(0, 8).join(', ')}`
        : 'No production-looking groups or hosts',
      `Environment: ${probe.label}`,
    ].filter(Boolean);
    const go = 'Run for real';
    const pick = await vscode.window.showWarningMessage(
      `Run "${doc.flow.name}" for real on ${facts.count} host(s)${extra ? ` and ${extra} inventory_target host(s)` : ''}?`,
      { modal: true, detail: detail.join('\n') },
      go,
    );
    if (pick !== go) return fail(CANCELLED, 'cancelled');
  }

  const ask = config.get<'auto' | 'always' | 'never'>('run.askVaultPassword', 'auto');
  let vaultPassword: string | undefined;
  if (ask === 'always' || (ask === 'auto' && facts.vault)) {
    vaultPassword = await vscode.window.showInputBox({
      title: 'Vault password',
      prompt: 'Used for this run only; never stored or logged',
      password: true,
      ignoreFocusOut: true,
    });
    if (vaultPassword === undefined) return fail(CANCELLED, 'cancelled');
  }

  const runDir = vscode.Uri.joinPath(deps.storage, 'runs', doc.flow.id, id);
  await vscode.workspace.fs.createDirectory(runDir);
  // Secret inputs travel in an environment variable only; vars.json goes when the run ends.
  const { plain, secret } = splitInputs(inputs);
  const secrets = Object.keys(secret).length > 0;
  await vscode.workspace.fs.writeFile(
    vscode.Uri.joinPath(runDir, 'vars.json'),
    new TextEncoder().encode(JSON.stringify(plain, null, 2)),
  );
  await pruneRuns(
    deps.storage.fsPath,
    doc.flow.id,
    config.get<number>('runs.keep', KEEP_RUNS),
  ).catch(() => undefined);
  const root = generated.result.files[0]?.name ?? `${doc.flow.key}.yml`;
  const playbook = vscode.workspace
    .asRelativePath(vscode.Uri.joinPath(generated.dir, root), false)
    .replaceAll('\\', '/');
  const spec = runProcess(
    env.env,
    { root: folder.uri.fsPath, probe: deps.probeDir },
    {
      playbook,
      inventory,
      check: options.mode === 'check',
      runDir: runDir.fsPath,
      vault: vaultPassword !== undefined,
      secrets,
      hasConfig: existsSync(vscode.Uri.joinPath(folder.uri, 'ansible.cfg').fsPath),
    },
    `afd-run-${id.toLowerCase()}`,
  );

  const audit = {
    run: id,
    ...(await auditHeader(document, doc)),
    mode: options.mode,
    environment: probe.label,
    inventory: facts.sources,
    hosts: facts.count,
    // The declared pattern: a resolved one can hold input values, which the audit never records.
    targets: uses.map((u) => ({ target: u.declared, nodes: u.nodes, hosts: u.count })),
    prod,
    vault: vaultPassword !== undefined,
  };
  await appendAudit(deps.storage, { event: 'launch', ...audit });
  const running: RunView = {
    id,
    mode: options.mode,
    state: 'running',
    startedAt,
    environment: probe.label,
    source: 'local',
    flowVersion: doc.flow.version,
    design: nodeDesigns(doc),
  };
  deps.report(running);

  const env2: Record<string, string> = { ...spec.env };
  if (vaultPassword !== undefined) env2.AFD_VAULT_PASSWORD = vaultPassword;
  if (secrets) env2.AFD_SECRET_VARS = JSON.stringify(secret);
  const task = new vscode.Task(
    { type: 'afd-run', flow: doc.flow.key, mode: options.mode },
    folder,
    `${doc.flow.key} (${options.mode === 'check' ? 'skeleton, check mode' : 'real run'})`,
    'Ansible Flow',
    new vscode.ProcessExecution(spec.command, spec.args, { cwd: spec.cwd, env: env2 }),
  );
  task.presentationOptions = {
    reveal: vscode.TaskRevealKind.Always,
    panel: vscode.TaskPanelKind.Dedicated,
    clear: true,
  };
  const t0 = Date.now();
  // Stop Run (AFD-39) terminates the task; the run then ends as stopped, not as an error.
  let stopped = false;
  let registration: vscode.Disposable | undefined;
  const rc = await new Promise<number | undefined>((resolve) => {
    let execution: vscode.TaskExecution | undefined;
    // A terminated task may end without a process exit event: either event ends the run.
    const sub = vscode.tasks.onDidEndTaskProcess((e) => {
      if (e.execution !== execution) return;
      sub.dispose();
      ended.dispose();
      resolve(e.exitCode);
    });
    const ended = vscode.tasks.onDidEndTask((e) => {
      if (e.execution !== execution || !stopped) return;
      sub.dispose();
      ended.dispose();
      resolve(undefined);
    });
    void vscode.tasks.executeTask(task).then(
      (x) => {
        execution = x;
        registration = runStarted(document.uri, async () => {
          stopped = true;
          x.terminate();
        });
      },
      () => {
        sub.dispose();
        ended.dispose();
        resolve(undefined);
      },
    );
  });
  registration?.dispose();

  await dropVars(runDir.fsPath).catch(() => undefined);
  let text = '';
  try {
    text = new TextDecoder().decode(
      await vscode.workspace.fs.readFile(vscode.Uri.joinPath(runDir, 'events.jsonl')),
    );
  } catch {}
  const summary = summarizeRun(text, generated.result.routes);
  const done: RunView = {
    ...running,
    state: rc === undefined || stopped ? 'error' : 'done',
    finishedAt: new Date().toISOString(),
    rc,
    summary,
    error: stopped
      ? 'Stopped by the user'
      : rc === undefined
        ? 'The run could not be started'
        : text
          ? undefined
          : 'The run produced no events',
    ...(stopped ? { errorCode: 'cancelled' as const } : {}),
  };
  await appendAudit(deps.storage, {
    event: 'finish',
    run: id,
    rc,
    ms: Date.now() - t0,
    hosts: summary.hosts.length,
    failed: Object.keys(summary.outcome).length + summary.failures.length,
  });
  deps.report(done);
  return done;
}

// Run as skeleton (check mode) and local real runs (decision 18, ADR-0009): regenerate, ask for the
// flow inputs, confirm real runs with inventory facts, prompt for the vault password per run, run
// ansible-playbook in a terminal task, audit the launch, and map the events back to nodes.
import { existsSync } from 'node:fs';
import * as vscode from 'vscode';
import { parseFlow } from '../../core/flow/document';
import type { SchemaValidator } from '../../core/flow/schema';
import type { FlowDocument } from '../../core/flow/types';
import type { RunView } from '../../core/protocol';
import { runProcess } from '../../core/run/command';
import { summarizeRun } from '../../core/run/events';
import { generateFlow } from '../codegen';
import { environmentFor, type ProbeManager } from '../env/environment';
import { authorName } from '../gitHead';
import { appendAudit } from './audit';

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

const inputsKey = (flowId: string) => `afd.inputs.${flowId}`;

function parseInput(type: string | undefined, text: string): unknown {
  const t = text.trim();
  switch (type) {
    case 'host_list':
      return t
        .split(/[,\s]+/)
        .map((s) => s.trim())
        .filter(Boolean);
    case 'integer':
      return Number(t);
    case 'boolean':
      return /^(true|yes|1)$/i.test(t);
    case 'list':
    case 'dict':
      try {
        return JSON.parse(t);
      } catch {
        return t;
      }
    default:
      return t;
  }
}

function showInput(value: unknown): string {
  if (Array.isArray(value)) return value.join(', ');
  if (value !== null && typeof value === 'object') return JSON.stringify(value);
  return value === undefined ? '' : String(value);
}

/** Flow inputs: given values, else remembered ones (per flow, this workspace), else prompted. */
export async function collectInputs(
  doc: FlowDocument,
  given: Record<string, unknown> | undefined,
  state: vscode.Memento,
): Promise<Record<string, unknown> | undefined> {
  const remembered = state.get<Record<string, unknown>>(inputsKey(doc.flow.id), {});
  const values: Record<string, unknown> = {};
  for (const [name, field] of Object.entries(doc.flow.inputs ?? {})) {
    if (given && name in given) {
      values[name] = given[name];
      continue;
    }
    if (given) {
      if (field?.default !== undefined) values[name] = field.default;
      continue;
    }
    const needed = field?.required || field?.type === 'host_list';
    if (!needed) {
      if (field?.default !== undefined) values[name] = remembered[name] ?? field.default;
      continue;
    }
    const text = await vscode.window.showInputBox({
      title: `Run ${doc.flow.name}: input "${name}"`,
      prompt:
        field?.type === 'host_list'
          ? 'Hosts or groups, comma-separated'
          : `${field?.type ?? 'value'}`,
      value: showInput(remembered[name] ?? field?.default),
      ignoreFocusOut: true,
      validateInput: (v) => (v.trim() ? undefined : 'Required'),
    });
    if (text === undefined) return undefined;
    values[name] = parseInput(field?.type, text);
  }
  await state.update(inputsKey(doc.flow.id), { ...remembered, ...values });
  return values;
}

export function targetsOf(doc: FlowDocument, inputs: Record<string, unknown>): string[] {
  const lists = Object.entries(doc.flow.inputs ?? {}).filter(([, f]) => f?.type === 'host_list');
  const name = (lists.find(([, f]) => f.targets) ?? lists[0])?.[0];
  const value = name ? inputs[name] : undefined;
  return Array.isArray(value) ? value.map(String) : [];
}

export function stamp(d = new Date()): string {
  return d
    .toISOString()
    .replaceAll(/[-:]/g, '')
    .replace(/\.\d+Z$/, 'Z');
}

export async function runFlow(
  document: vscode.TextDocument,
  deps: RunDeps,
  options: RunOptions,
): Promise<RunView> {
  const startedAt = new Date().toISOString();
  const id = stamp();
  const fail = (error: string): RunView => {
    const run: RunView = { id, mode: options.mode, state: 'error', startedAt, error };
    deps.report(run);
    return run;
  };

  if (document.isDirty) await document.save();
  const folder = vscode.workspace.getWorkspaceFolder(document.uri);
  if (!folder) return fail('Open the repository folder that contains this flow first');
  const generated = await generateFlow(document, deps.schema);
  if (!generated.ok || !generated.result || !generated.dir)
    return fail(generated.error ?? 'Code generation failed');
  if (generated.kept.length > 0)
    return fail('Generated code was edited by hand: run "Generate Playbook" first');
  const doc = parseFlow(document.getText()).doc;
  if (!doc) return fail('The flow does not parse');

  const env = environmentFor(folder.uri);
  if (!env.ok) {
    void vscode.window
      .showErrorMessage(env.error, 'Open Settings')
      .then(
        (pick) =>
          pick &&
          vscode.commands.executeCommand('workbench.action.openSettings', 'afd.environment'),
      );
    return fail(env.error);
  }
  const inputs = await collectInputs(doc, options.inputs, deps.state);
  if (!inputs) return fail('Cancelled');
  const targets = targetsOf(doc, inputs);
  if (targets.length === 0) return fail('No target hosts: the targets input is empty');

  const config = vscode.workspace.getConfiguration('afd', document.uri);
  const inventory = config.get<string>('run.inventory', '') || undefined;
  const probe = deps.probes.forFolder(folder.uri);
  if ('error' in probe) return fail(probe.error);
  let facts: InventoryFacts;
  try {
    facts = await probe.client.call<InventoryFacts>('inventory', { inventory, targets }, 120_000);
  } catch (e) {
    return fail(`The Ansible environment (${probe.label}) did not answer: ${(e as Error).message}`);
  }
  if (facts.count === 0)
    return fail(`None of the targets (${targets.join(', ')}) is in the inventory`);

  if (options.mode === 'real' && !(deps.testMode && options.yes)) {
    const shown = facts.hosts.slice(0, 8).join(', ') + (facts.count > 8 ? ', …' : '');
    const detail = [
      'This is not check mode: bound nodes change the devices.',
      `Inventory: ${facts.sources.join(', ')}`,
      `Hosts: ${facts.count} (${shown})`,
      facts.unknown.length ? `Not in the inventory: ${facts.unknown.join(', ')}` : '',
      facts.prod_groups.length || facts.prod_hosts.length
        ? `Production-looking: ${[...facts.prod_groups, ...facts.prod_hosts.slice(0, 5)].join(', ')}`
        : 'No production-looking groups or hosts',
      `Environment: ${probe.label}`,
    ].filter(Boolean);
    const go = 'Run for real';
    const pick = await vscode.window.showWarningMessage(
      `Run "${doc.flow.name}" for real on ${facts.count} host(s)?`,
      { modal: true, detail: detail.join('\n') },
      go,
    );
    if (pick !== go) return fail('Cancelled');
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
    if (vaultPassword === undefined) return fail('Cancelled');
  }

  const runDir = vscode.Uri.joinPath(deps.storage, 'runs', doc.flow.id, id);
  await vscode.workspace.fs.createDirectory(runDir);
  await vscode.workspace.fs.writeFile(
    vscode.Uri.joinPath(runDir, 'vars.json'),
    new TextEncoder().encode(JSON.stringify(inputs, null, 2)),
  );
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
      hasConfig: existsSync(vscode.Uri.joinPath(folder.uri, 'ansible.cfg').fsPath),
    },
    `afd-run-${id.toLowerCase()}`,
  );

  const audit = {
    run: id,
    user: await authorName(document.uri),
    flow: {
      id: doc.flow.id,
      key: doc.flow.key,
      version: doc.flow.version,
      file: vscode.workspace.asRelativePath(document.uri),
    },
    mode: options.mode,
    environment: probe.label,
    inventory: facts.sources,
    hosts: facts.count,
    prod: [...facts.prod_groups, ...facts.prod_hosts],
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
  };
  deps.report(running);

  const env2: Record<string, string> = { ...spec.env };
  if (vaultPassword !== undefined) env2.AFD_VAULT_PASSWORD = vaultPassword;
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
  const rc = await new Promise<number | undefined>((resolve) => {
    let execution: vscode.TaskExecution | undefined;
    const sub = vscode.tasks.onDidEndTaskProcess((e) => {
      if (e.execution !== execution) return;
      sub.dispose();
      resolve(e.exitCode);
    });
    void vscode.tasks.executeTask(task).then(
      (x) => {
        execution = x;
      },
      () => {
        sub.dispose();
        resolve(undefined);
      },
    );
  });

  let text = '';
  try {
    text = new TextDecoder().decode(
      await vscode.workspace.fs.readFile(vscode.Uri.joinPath(runDir, 'events.jsonl')),
    );
  } catch {}
  const summary = summarizeRun(text, generated.result.routes);
  const done: RunView = {
    ...running,
    state: rc === undefined ? 'error' : 'done',
    finishedAt: new Date().toISOString(),
    rc,
    summary,
    error:
      rc === undefined
        ? 'The run could not be started'
        : text
          ? undefined
          : 'The run produced no events',
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

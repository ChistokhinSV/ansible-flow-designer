// Run as skeleton (check mode) and local real runs (decision 18, ADR-0009): regenerate, ask for the
// flow inputs, confirm real runs with inventory facts, prompt for the vault password per run, run
// ansible-playbook in a terminal task, audit the launch, and map the events back to nodes. AFD-81:
// the events are read while the run goes, so the canvas follows it; with the flow's designer open
// the terminal stays out of the way unless the run stalls or the canvas cannot explain it.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import * as vscode from 'vscode';
import { engineFor } from '../../core/engine/engines';
import { type PartialRun, partialFlow, partialLine } from '../../core/engine/partial';
import { resolvePattern, targetUses } from '../../core/engine/targets';
import { flowFileId } from '../../core/flow/ids';
import { buildModel } from '../../core/flow/model';
import type { SchemaValidator } from '../../core/flow/schema';
import { nodeDesigns } from '../../core/flow/semantic';
import type { FlowDocument } from '../../core/flow/types';
import type { RunErrorCode, RunView } from '../../core/protocol';
import { runProcess, splitInputs } from '../../core/run/command';
import { createSummarizer, summarizeRun } from '../../core/run/events';
import {
  type LaunchFacts,
  realRunLines,
  realRunQuestion,
  sameFacts,
  type TargetUse,
} from '../../core/run/launch';
import { redactLine, redactText, revealAfterRun, secretValues } from '../../core/run/redact';
import { groupHosts, type InventoryTree } from '../../core/view/inventoryTree';
import { stopStarted } from '../../node/run/stop';
import { dropVars, KEEP_RUNS, pruneRuns } from '../../node/run/storage';
import { tailFile } from '../../node/run/tail';
import { followRunFile, putRunFile, removeRunDir, syncWorkspace } from '../../node/ssh/remote';
import { TIMEOUTS } from '../../node/timeouts';
import { rootFromGenerated } from '../codegen';
import { environmentFor, type ProbeManager } from '../env/environment';
import { showEnvironmentError } from '../env/setupEnvironment';
import { CANCELLED } from '../errors';
import { appendAudit } from './audit';
import { collectInputs, targetsOf } from './inputs';
import { keepRun } from './pastRuns';
import { auditHeader, prepareRun, stamp } from './prepare';
import { runStarted } from './stop';
import { showRunTerminal, watchRunTerminal } from './terminal';

/** How often a live run updates the canvas, at most (AFD-81). */
export const LIVE_MS = 500;
/** No new events for this long: the run may wait for input in its quiet terminal. */
export const STALL_MS = 20_000;
/** AFD-244: where a partial run's code is generated, beside generated/; removed after the run. */
export const PARTIAL_DIR = '.afd-run';

export interface RunOptions {
  mode: 'check' | 'real';
  /** Flow input values; prompted for when missing. */
  inputs?: Record<string, unknown>;
  /** Test mode only: answer the real-run confirmation with yes. */
  yes?: boolean;
  /**
   * AFD-82: the launch dialog showed the facts and the person chose Run. Set by the host only,
   * after it checked the dialog's single-use token; never from a command argument.
   */
  confirmed?: boolean;
  /** The facts the dialog showed: when the inventory answers differently now, nothing runs. */
  expect?: LaunchFacts;
  /** From the dialog: the vault password for this run (asked for otherwise). */
  vaultPassword?: string;
  /** AFD-244: start at a top-level step, or run that step alone. Skeleton runs only. */
  partial?: PartialRun;
}

export interface RunDeps {
  schema: SchemaValidator;
  probes: ProbeManager;
  probeDir: string;
  storage: vscode.Uri;
  state: vscode.Memento;
  testMode: boolean;
  report: (run: RunView) => void;
  /** The flow's designer is open: the canvas shows the run, the terminal stays quiet (AFD-81). */
  designerOpen?: () => boolean;
}

interface InventoryFacts {
  sources: string[];
  count: number;
  hosts: string[];
  unknown: string[];
  prod_groups: string[];
  prod_hosts: string[];
  vault: boolean;
  /** Per group, how many of the matched hosts it has. */
  groups?: Record<string, number>;
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

/**
 * What a run with these inputs would touch (the real-run confirmation, the launch dialog): the
 * hosts the targets match in the inventory, the inventory_targets, what looks like production.
 */
export async function launchFacts(
  doc: FlowDocument,
  inputs: Record<string, unknown>,
  folder: vscode.Uri,
  probes: ProbeManager,
): Promise<{ ok: true; facts: LaunchFacts } | { ok: false; error: string }> {
  const targets = targetsOf(doc, inputs);
  if (targets.length === 0)
    return { ok: false, error: 'No target hosts: the targets input is empty' };
  const inventory =
    vscode.workspace.getConfiguration('afd', folder).get<string>('run.inventory', '') || undefined;
  const probe = probes.forFolder(folder);
  if ('error' in probe) return { ok: false, error: probe.error };
  let found: InventoryFacts;
  try {
    found = await probe.client.call<InventoryFacts>(
      'inventory',
      { inventory, targets },
      TIMEOUTS.probeInventory,
    );
  } catch (e) {
    return {
      ok: false,
      error: `The Ansible environment (${probe.label}) did not answer: ${(e as Error).message}`,
    };
  }
  if (found.count === 0)
    return { ok: false, error: `None of the targets (${targets.join(', ')}) is in the inventory` };
  const uses = await targetFacts(doc, inputs, (pattern) =>
    probe.client.call<InventoryFacts>(
      'inventory',
      { inventory, targets: [pattern] },
      TIMEOUTS.probeInventory,
    ),
  );
  const prod = [
    ...new Set([...found.prod_groups, ...found.prod_hosts, ...uses.flatMap((u) => u.prod)]),
  ];
  return {
    ok: true,
    facts: {
      sources: found.sources,
      count: found.count,
      hosts: found.hosts,
      unknown: found.unknown,
      uses,
      prod,
      vault: found.vault,
      environment: probe.label,
    },
  };
}

/**
 * The inventory's groups, for the dialog's host list suggestions (AFD-82), with each group's hosts
 * (AFD-95, from the probe's inventory_tree, one inventory parse as before); none when it fails.
 */
export async function inventoryGroups(
  folder: vscode.Uri,
  probes: ProbeManager,
): Promise<{ groups: string[]; hosts: Record<string, { count: number; hosts: string[] }> }> {
  const inventory =
    vscode.workspace.getConfiguration('afd', folder).get<string>('run.inventory', '') || undefined;
  const probe = probes.forFolder(folder);
  if ('error' in probe) return { groups: [], hosts: {} };
  try {
    const tree = await probe.client.call<InventoryTree>(
      'inventory_tree',
      { inventory },
      TIMEOUTS.probeInventory,
    );
    const hosts = groupHosts(tree);
    return { groups: Object.keys(hosts).sort((a, b) => a.localeCompare(b)), hosts };
  } catch {
    return { groups: [], hosts: {} };
  }
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
  // AFD-244: a partial run executes a trimmed copy of the flow, generated beside generated/ for
  // this run only; the flow's own code is not touched.
  let code = generated.result;
  let codeDir = generated.dir;
  let partial: RunView['partial'];
  if (options.partial) {
    if (options.mode !== 'check') return fail('Only a skeleton run can run part of a flow');
    const trimmed = partialFlow(doc, options.partial);
    if ('error' in trimmed) return fail(trimmed.error);
    const built = engineFor(trimmed.doc).generate(trimmed.doc, {
      source: document.uri.path.split('/').pop() ?? 'flow.yaml',
      root: rootFromGenerated(document.uri),
    });
    if (!built.ok)
      return fail(
        `This part of the flow does not generate: ${built.findings.find((f) => f.severity === 'error')?.message ?? 'see the flow problems'}`,
      );
    code = built;
    codeDir = vscode.Uri.joinPath(document.uri, '..', PARTIAL_DIR);
    const title = doc.nodes && buildModel(doc).nodes.get(options.partial.node)?.node.title;
    partial = {
      ...options.partial,
      line: partialLine(title ?? options.partial.node, options.partial.only, trimmed),
      stubbed: trimmed.stubbed.map((s) => s.node),
    };
  }

  const env = environmentFor(folder.uri);
  if (!env.ok) {
    showEnvironmentError(env.error, () => runFlow(document, deps, options));
    return fail(env.error, 'environment');
  }
  const inputs = await collectInputs(doc, options.inputs, deps.state, options.mode === 'check');
  if (!inputs) return fail(CANCELLED, 'cancelled');

  const config = vscode.workspace.getConfiguration('afd', document.uri);
  const inventory = config.get<string>('run.inventory', '') || undefined;
  const probe = deps.probes.forFolder(folder.uri);
  if ('error' in probe) return fail(probe.error);
  const found = await launchFacts(doc, inputs, folder.uri, deps.probes);
  if (!found.ok) return fail(found.error);
  const facts = found.facts;
  const { uses, prod } = facts;
  // AFD-82: the dialog showed other facts than the inventory gives now: show them again first.
  if (options.expect && !sameFacts(options.expect, facts))
    return fail('What the run would touch changed since the dialog showed it', 'changed');

  if (options.mode === 'real' && !options.confirmed && !(deps.testMode && options.yes)) {
    const go = 'Run for real';
    const pick = await vscode.window.showWarningMessage(
      realRunQuestion(doc.flow.name, facts),
      { modal: true, detail: realRunLines(facts).join('\n') },
      go,
    );
    if (pick !== go) return fail(CANCELLED, 'cancelled');
  }

  const ask = config.get<'auto' | 'always' | 'never'>('run.askVaultPassword', 'auto');
  let vaultPassword: string | undefined = options.vaultPassword;
  if (vaultPassword === undefined && (ask === 'always' || (ask === 'auto' && facts.vault))) {
    vaultPassword = await vscode.window.showInputBox({
      title: 'Vault password',
      prompt: 'Used for this run only; never stored or logged',
      password: true,
      ignoreFocusOut: true,
    });
    if (vaultPassword === undefined) return fail(CANCELLED, 'cancelled');
  }

  const runDir = vscode.Uri.joinPath(deps.storage, 'runs', flowFileId(doc.flow.id), id);
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
  // AFD-141: the repository's callbacks keep running next to ours; without an answer, ours alone.
  const callbacks = await probe.client
    .call<{ callbacks_enabled: string[]; callback_plugins: string[] }>(
      'run_config',
      {},
      TIMEOUTS.probeInventory,
    )
    .then((c) => ({ enabled: c.callbacks_enabled ?? [], paths: c.callback_plugins ?? [] }))
    .catch(() => undefined);
  if (partial) {
    // Written last, after every question the run asks: a run given up leaves no folder.
    await vscode.workspace.fs.delete(codeDir, { recursive: true }).then(undefined, () => undefined);
    await vscode.workspace.fs.createDirectory(codeDir);
    const put = (name: string, text: string) =>
      vscode.workspace.fs.writeFile(
        vscode.Uri.joinPath(codeDir, name),
        new TextEncoder().encode(text),
      );
    // Never committed: the folder ignores itself.
    await put('.gitignore', '*\n');
    for (const file of code.files) await put(file.name, file.text);
  }
  // AFD-247: an SSH host runs a copy of the repository: brought up to date now, with the code just
  // generated (a partial run's folder ignores itself in Git, so it is named), and the inputs.
  const remote = env.env.kind === 'ssh' ? env.env : undefined;
  if (remote) {
    const extra = vscode.workspace.asRelativePath(codeDir, false).replaceAll('\\', '/');
    const failed =
      (await syncWorkspace(
        remote,
        { root: folder.uri.fsPath, probe: deps.probeDir },
        partial ? [extra] : [],
      )) ?? (await putRunFile(remote, runDir.fsPath, 'vars.json', JSON.stringify(plain, null, 2)));
    if (failed) return fail(failed);
  }
  const root = code.files[0]?.name ?? `${doc.flow.key}.yml`;
  const playbook = vscode.workspace
    .asRelativePath(vscode.Uri.joinPath(codeDir, root), false)
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
      callbacks,
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
    ...(partial ? { partial } : {}),
  };
  deps.report(running);

  const env2: Record<string, string> = { ...spec.env };
  // AFD-75: names WSL should take from Windows join the ones already set, if any.
  if (spec.env.WSLENV && process.env.WSLENV)
    env2.WSLENV = `${process.env.WSLENV}:${spec.env.WSLENV}`;
  if (vaultPassword !== undefined) env2.AFD_VAULT_PASSWORD = vaultPassword;
  if (secrets) env2.AFD_SECRET_VARS = JSON.stringify(secret);
  const label = `${doc.flow.key} (${options.mode === 'check' ? 'skeleton, check mode' : 'real run'})`;
  const task = new vscode.Task(
    { type: 'afd-run', flow: doc.flow.key, mode: options.mode },
    folder,
    label,
    'Ansible Flow',
    // AFD-247: over SSH the secrets go on the connection's input, written by afd-ssh-run.
    spec.input?.length
      ? new vscode.ProcessExecution(
          process.execPath,
          [
            join(deps.probeDir, '..', 'afd-ssh-run.js'),
            spec.input.join(','),
            spec.command,
            ...spec.args,
          ],
          { cwd: spec.cwd, env: { ...env2, ELECTRON_RUN_AS_NODE: '1' } },
        )
      : new vscode.ProcessExecution(spec.command, spec.args, { cwd: spec.cwd, env: env2 }),
  );
  const designerOpen = deps.designerOpen?.() ?? false;
  task.presentationOptions = {
    reveal: designerOpen ? vscode.TaskRevealKind.Silent : vscode.TaskRevealKind.Always,
    panel: vscode.TaskPanelKind.Dedicated,
    clear: true,
  };
  const t0 = Date.now();
  const terminal = watchRunTerminal(document.uri, label);
  // The events as they come: a partial summary for the canvas at most every LIVE_MS, secrets out.
  // AFD-138: the vault password too, if a task prints it.
  const hidden = secretValues(vaultPassword ? { ...secret, '': vaultPassword } : secret);
  const live = createSummarizer(code.routes);
  const eventsFile = vscode.Uri.joinPath(runDir, 'events.jsonl');
  // AFD-247: the events are written on the host; they are followed into the file here.
  const following = remote
    ? followRunFile(remote, runDir.fsPath, 'events.jsonl', eventsFile.fsPath)
    : undefined;
  let lastEvent = Date.now();
  let changed = false;
  let quiet = false;
  const tail = tailFile(eventsFile.fsPath, (lines) => {
    for (const line of lines) live.push(redactLine(line, hidden));
    lastEvent = Date.now();
    changed = true;
    quiet = false;
  });
  const ticker = setInterval(() => {
    if (designerOpen && !quiet && Date.now() - lastEvent > STALL_MS) {
      quiet = true;
      changed = true;
      const show = 'Show Terminal';
      void vscode.window
        .showInformationMessage(
          `No new events from "${doc.flow.name}" for ${STALL_MS / 1000} s: a step may be slow, or waiting for input in the run's terminal.`,
          show,
        )
        .then((pick) => (pick === show ? showRunTerminal(document.uri) : undefined));
    }
    if (!changed) return;
    changed = false;
    deps.report({
      ...running,
      summary: live.summary({ partial: true }),
      ...(quiet ? { quiet } : {}),
    });
  }, LIVE_MS);
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
          // AFD-131: the container first, so the playbook stops changing hosts and writing
          // events before the redaction pass below reads them; the task then ends by itself.
          await stopStarted(spec);
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
  clearInterval(ticker);
  terminal.dispose();
  await following?.stop();
  await tail.stop();
  if (remote) await removeRunDir(remote, runDir.fsPath);

  await dropVars(runDir.fsPath).catch(() => undefined);
  if (partial)
    await vscode.workspace.fs.delete(codeDir, { recursive: true }).then(undefined, () => undefined);
  let text = '';
  try {
    text = new TextDecoder().decode(await vscode.workspace.fs.readFile(eventsFile));
    // The kept events hold no secret input value either (the output now comes with them).
    if (hidden.length > 0) {
      text = redactText(text, hidden);
      await vscode.workspace.fs.writeFile(eventsFile, new TextEncoder().encode(text));
    }
  } catch {}
  const summary = summarizeRun(text, code.routes);
  if (revealAfterRun({ designerOpen, stopped, rc, events: !!text.trim(), summary }))
    void showRunTerminal(document.uri);
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
  // AFD-245: kept with its events, so the Run panel can show it again later.
  await keepRun(runDir, done);
  deps.report(done);
  return done;
}

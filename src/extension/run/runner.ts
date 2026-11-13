// Run as skeleton (check mode) and local real runs (decision 18, ADR-0009): regenerate, ask for the
// flow inputs, confirm real runs with inventory facts, prompt for the vault password per run, run
// ansible-playbook in a terminal task, audit the launch, and map the events back to nodes. AFD-81:
// the events are read while the run goes, so the canvas follows it; with the flow's designer open
// the terminal stays out of the way unless the run stalls or the canvas cannot explain it.
//
// AFD-271: what a run does once every question is answered (the run's folder, the process's
// environment, following its events, redaction, keeping the result) is node/run/runFlow.ts, shared
// with hosts that run flows without VS Code. This file asks the questions and supplies the terminal.
import { join } from 'node:path';
import * as vscode from 'vscode';
import { engineFor } from '../../core/engine/engines';
import { type PartialRun, partialFlow, partialLine } from '../../core/engine/partial';
import { buildModel } from '../../core/flow/model';
import type { SchemaValidator } from '../../core/flow/schema';
import type { FlowDocument } from '../../core/flow/types';
import type { RunErrorCode, RunView } from '../../core/protocol';
import type { ProcessSpec } from '../../core/run/command';
import {
  type LaunchFacts,
  realRunLines,
  realRunQuestion,
  sameFacts,
  targetsOf,
} from '../../core/run/launch';
import { revealAfterRun } from '../../core/run/redact';
import type { Execution } from '../../node/run/exec';
import {
  launchFacts as factsOfLaunch,
  inventoryGroups as groupsOfInventory,
  repositoryCallbacks,
} from '../../node/run/facts';
import { stamp } from '../../node/run/ids';
import { LIVE_MS, runFlow as runGenerated, STALL_MS } from '../../node/run/runFlow';
import { KEEP_RUNS } from '../../node/run/storage';
import { rootFromGenerated } from '../codegen';
import { environmentFor, type ProbeManager } from '../env/environment';
import { showEnvironmentError } from '../env/setupEnvironment';
import { CANCELLED } from '../errors';
import { collectInputs } from './inputs';
import { auditHeader, prepareRun } from './prepare';
import { runStarted } from './stop';
import { showRunTerminal, watchRunTerminal } from './terminal';

export { LIVE_MS, STALL_MS };
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

const inventoryOf = (scope: vscode.Uri): string | undefined =>
  vscode.workspace.getConfiguration('afd', scope).get<string>('run.inventory', '') || undefined;

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
  // The targets first: an empty list needs no Ansible environment to say so.
  if (targetsOf(doc, inputs).length === 0)
    return { ok: false, error: 'No target hosts: the targets input is empty' };
  const probe = probes.forFolder(folder);
  if ('error' in probe) return { ok: false, error: probe.error };
  return factsOfLaunch(doc, inputs, probe, inventoryOf(folder));
}

/**
 * The inventory's groups, for the dialog's host list suggestions (AFD-82), with each group's hosts
 * (AFD-95, from the probe's inventory_tree, one inventory parse as before); none when it fails.
 */
export async function inventoryGroups(
  folder: vscode.Uri,
  probes: ProbeManager,
): Promise<{ groups: string[]; hosts: Record<string, { count: number; hosts: string[] }> }> {
  const probe = probes.forFolder(folder);
  if ('error' in probe) return { groups: [], hosts: {} };
  return groupsOfInventory(probe, inventoryOf(folder));
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

  // AFD-141: the repository's callbacks keep running next to ours; without an answer, ours alone.
  const callbacks = await repositoryCallbacks(probe);
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
  const relative = (uri: vscode.Uri) =>
    vscode.workspace.asRelativePath(uri, false).replaceAll('\\', '/');
  const root = code.files[0]?.name ?? `${doc.flow.key}.yml`;
  const label = `${doc.flow.key} (${options.mode === 'check' ? 'skeleton, check mode' : 'real run'})`;
  const designerOpen = deps.designerOpen?.() ?? false;

  /** The run as a VS Code task in a terminal of its own, so its output and its prompts show. */
  const inTerminal = (
    spec: ProcessSpec,
    processEnv: Record<string, string>,
    stopping: () => boolean,
  ): Promise<Execution> => {
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
            { cwd: spec.cwd, env: { ...processEnv, ELECTRON_RUN_AS_NODE: '1' } },
          )
        : new vscode.ProcessExecution(spec.command, spec.args, { cwd: spec.cwd, env: processEnv }),
    );
    task.presentationOptions = {
      reveal: designerOpen ? vscode.TaskRevealKind.Silent : vscode.TaskRevealKind.Always,
      panel: vscode.TaskPanelKind.Dedicated,
      clear: true,
    };
    const terminal = watchRunTerminal(document.uri, label);
    return new Promise<Execution>((started) => {
      let execution: vscode.TaskExecution | undefined;
      const exit = new Promise<number | undefined>((resolve) => {
        // A terminated task may end without a process exit event: either event ends the run.
        const sub = vscode.tasks.onDidEndTaskProcess((e) => {
          if (e.execution !== execution) return;
          sub.dispose();
          ended.dispose();
          resolve(e.exitCode);
        });
        const ended = vscode.tasks.onDidEndTask((e) => {
          if (e.execution !== execution || !stopping()) return;
          sub.dispose();
          ended.dispose();
          resolve(undefined);
        });
        void vscode.tasks.executeTask(task).then(
          (x) => {
            execution = x;
            started({ exit, terminate: () => x.terminate() });
          },
          () => {
            sub.dispose();
            ended.dispose();
            resolve(undefined);
            started({ exit, terminate: () => undefined });
          },
        );
      }).finally(() => terminal.dispose());
    });
  };

  return runGenerated(
    {
      id,
      startedAt,
      mode: options.mode,
      doc,
      code,
      env: env.env,
      environment: probe.label,
      root: folder.uri.fsPath,
      probeDir: deps.probeDir,
      playbook: relative(vscode.Uri.joinPath(codeDir, root)),
      inventory,
      storage: deps.storage.fsPath,
      keepRuns: config.get<number>('runs.keep', KEEP_RUNS),
      inputs,
      vaultPassword,
      callbacks,
      ...(partial ? { partial, syncAlso: [relative(codeDir)] } : {}),
      audit: {
        ...(await auditHeader(document, doc)),
        mode: options.mode,
        environment: probe.label,
        inventory: facts.sources,
        hosts: facts.count,
        // The declared pattern: a resolved one can hold input values, which the audit never records.
        targets: uses.map((u) => ({ target: u.declared, nodes: u.nodes, hosts: u.count })),
        prod,
        vault: vaultPassword !== undefined,
      },
    },
    {
      report: deps.report,
      execute: inTerminal,
      // Stop Run (AFD-39) terminates the task; the run then ends as stopped, not as an error.
      started: (stop) => {
        const registration = runStarted(document.uri, stop);
        return () => registration.dispose();
      },
      watchQuiet: designerOpen,
      quiet: () => {
        const show = 'Show Terminal';
        void vscode.window
          .showInformationMessage(
            `No new events from "${doc.flow.name}" for ${STALL_MS / 1000} s: a step may be slow, or waiting for input in the run's terminal.`,
            show,
          )
          .then((pick) => (pick === show ? showRunTerminal(document.uri) : undefined));
      },
      ended: async () => {
        if (partial)
          await vscode.workspace.fs
            .delete(codeDir, { recursive: true })
            .then(undefined, () => undefined);
      },
      finished: (end) => {
        if (revealAfterRun({ designerOpen, ...end })) void showRunTerminal(document.uri);
      },
    },
  );
}

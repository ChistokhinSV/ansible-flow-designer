// One run of a flow's generated code (AFD-271): what the extension's local run and a server's run
// have in common. The caller has generated the code, resolved the environment, collected the
// inputs and asked whatever it asks; from there this writes the run's folder, starts
// ansible-playbook, follows its events into a view of the run, redacts and keeps the result.
//
// What differs between hosts is given as hooks: how the process is started (a VS Code terminal
// task, or a plain child process), who is told that the run went quiet, what is cleaned up.
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { GenerateResult } from '../../core/engine/types';
import { nodeDesigns } from '../../core/flow/semantic';
import type { FlowDocument } from '../../core/flow/types';
import type { RunView } from '../../core/protocol';
import { type ProcessSpec, runProcess, splitInputs } from '../../core/run/command';
import type { Environment } from '../../core/run/environment';
import { createSummarizer, type RunSummary, summarizeRun } from '../../core/run/events';
import { redactLine, redactText, secretValues } from '../../core/run/redact';
import { followRunFile, putRunFile, removeRunDir, syncWorkspace } from '../ssh/remote';
import { appendAudit } from './audit';
import { type Execution, startProcess } from './exec';
import { keepRun, runsDir } from './pastRuns';
import { stopStarted } from './stop';
import { dropVars, KEEP_RUNS, pruneRuns } from './storage';
import { tailFile } from './tail';

/** How often a live run updates its view, at most (AFD-81). */
export const LIVE_MS = 500;
/** No new events for this long: the run may wait for input. */
export const STALL_MS = 20_000;

export interface RunFlowRequest {
  /** The run's id (`stamp()`), which names its folder. */
  id: string;
  startedAt: string;
  mode: 'check' | 'real';
  doc: FlowDocument;
  /** The code that runs: its routes map the events back to nodes. */
  code: GenerateResult;
  env: Environment;
  /** The environment's name for people ("afd-ee:2.19 (docker)"). */
  environment: string;
  /** Repository root on this machine. */
  root: string;
  /** Folder with afd_probe/ and callback_plugins/afd_events.py. */
  probeDir: string;
  /** The playbook to run, relative to `root`, with forward slashes. */
  playbook: string;
  inventory?: string;
  /** Where runs are kept: `<storage>/runs/<flow id>/<run id>/`, and the audit log. */
  storage: string;
  /** How many runs of the flow to keep (default `KEEP_RUNS`). */
  keepRuns?: number;
  /** Flow input values. Secret ones never reach a file. */
  inputs: Record<string, unknown>;
  vaultPassword?: string;
  /** The repository's own callbacks, kept running beside the run's (`repositoryCallbacks`). */
  callbacks?: { enabled: string[]; paths: string[] };
  /** AFD-244: the run is of a part of the flow; its code is in a folder of its own. */
  partial?: RunView['partial'];
  /** AFD-247: paths the SSH copy needs that Git does not list (a partial run's folder). */
  syncAlso?: string[];
  /** What the audit log says about the launch, besides the run's id. Never input values. */
  audit?: Record<string, unknown>;
  /** Stops the run when it aborts. */
  signal?: AbortSignal;
}

export interface RunFlowHooks {
  /** The run's view: when it starts, as it goes (at most every `LIVE_MS`), and when it ends. */
  report(run: RunView): void;
  /**
   * Starts the process. Default: a child process whose output goes to `log`. `stopping` says the
   * run is being stopped, for a host whose process may end without an exit code then.
   */
  execute?(
    spec: ProcessSpec,
    env: Record<string, string>,
    stopping: () => boolean,
  ): Execution | Promise<Execution>;
  /** The default process's output, line by line. */
  log?(line: string): void;
  /** The run started; `stop` ends it. Returns what to call when the run has ended. */
  started?(stop: () => Promise<void>): (() => void) | undefined;
  /** Whether to watch for a run gone quiet (no event for `STALL_MS`). */
  watchQuiet?: boolean;
  /** The run went quiet. */
  quiet?(): void;
  /** The process ended; before its events are read. */
  ended?(): Promise<void>;
  /** How the run ended, before it is kept and reported. */
  finished?(end: {
    stopped: boolean;
    rc: number | undefined;
    events: boolean;
    summary: RunSummary;
  }): void;
}

/** Runs the flow's code and resolves with the finished run (also reported). Never rejects. */
export async function runFlow(request: RunFlowRequest, hooks: RunFlowHooks): Promise<RunView> {
  const { id, mode, doc, code, startedAt, vaultPassword, partial } = request;
  const fail = (error: string): RunView => {
    const run: RunView = { id, mode, state: 'error', startedAt, error };
    hooks.report(run);
    return run;
  };

  const runDir = join(runsDir(request.storage, doc.flow.id), id);
  await mkdir(runDir, { recursive: true });
  // Secret inputs travel in an environment variable only; vars.json goes when the run ends.
  const { plain, secret } = splitInputs(request.inputs);
  const secrets = Object.keys(secret).length > 0;
  await writeFile(join(runDir, 'vars.json'), JSON.stringify(plain, null, 2), 'utf8');
  await pruneRuns(request.storage, doc.flow.id, request.keepRuns ?? KEEP_RUNS).catch(
    () => undefined,
  );
  // AFD-247: an SSH host runs a copy of the repository: brought up to date now, with the code just
  // generated, and the inputs.
  const remote = request.env.kind === 'ssh' ? request.env : undefined;
  if (remote) {
    const failed =
      (await syncWorkspace(
        remote,
        { root: request.root, probe: request.probeDir },
        request.syncAlso ?? [],
      )) ?? (await putRunFile(remote, runDir, 'vars.json', JSON.stringify(plain, null, 2)));
    if (failed) return fail(failed);
  }
  const spec = runProcess(
    request.env,
    { root: request.root, probe: request.probeDir },
    {
      playbook: request.playbook,
      inventory: request.inventory,
      check: mode === 'check',
      runDir,
      vault: vaultPassword !== undefined,
      secrets,
      hasConfig: existsSync(join(request.root, 'ansible.cfg')),
      callbacks: request.callbacks,
    },
    `afd-run-${id.toLowerCase()}`,
  );

  if (request.audit)
    await appendAudit(request.storage, { event: 'launch', run: id, ...request.audit });
  const running: RunView = {
    id,
    mode,
    state: 'running',
    startedAt,
    environment: request.environment,
    source: 'local',
    flowVersion: doc.flow.version,
    design: nodeDesigns(doc),
    ...(partial ? { partial } : {}),
  };
  hooks.report(running);

  const env: Record<string, string> = { ...spec.env };
  // AFD-75: names WSL should take from Windows join the ones already set, if any.
  if (spec.env.WSLENV && process.env.WSLENV)
    env.WSLENV = `${process.env.WSLENV}:${spec.env.WSLENV}`;
  if (vaultPassword !== undefined) env.AFD_VAULT_PASSWORD = vaultPassword;
  if (secrets) env.AFD_SECRET_VARS = JSON.stringify(secret);

  const t0 = Date.now();
  // The events as they come: a partial summary at most every LIVE_MS, secrets out.
  // AFD-138: the vault password too, if a task prints it.
  const hidden = secretValues(vaultPassword ? { ...secret, '': vaultPassword } : secret);
  const live = createSummarizer(code.routes);
  const eventsFile = join(runDir, 'events.jsonl');
  // AFD-247: the events are written on the host; they are followed into the file here.
  const following = remote ? followRunFile(remote, runDir, 'events.jsonl', eventsFile) : undefined;
  let lastEvent = Date.now();
  let changed = false;
  let quiet = false;
  const tail = tailFile(eventsFile, (lines) => {
    for (const line of lines) live.push(redactLine(line, hidden));
    lastEvent = Date.now();
    changed = true;
    quiet = false;
  });
  const ticker = setInterval(() => {
    if (hooks.watchQuiet && !quiet && Date.now() - lastEvent > STALL_MS) {
      quiet = true;
      changed = true;
      hooks.quiet?.();
    }
    if (!changed) return;
    changed = false;
    hooks.report({
      ...running,
      summary: live.summary({ partial: true }),
      ...(quiet ? { quiet } : {}),
    });
  }, LIVE_MS);

  // Stopping ends the process; the run then ends as stopped, not as an error.
  let stopped = false;
  const execute = hooks.execute ?? ((s, e) => startProcess(s, e, hooks.log ?? (() => {})));
  let execution: Execution;
  try {
    execution = await execute(spec, env, () => stopped);
  } catch {
    execution = { exit: Promise.resolve(undefined), terminate: () => undefined };
  }
  const stop = async () => {
    stopped = true;
    // AFD-131: the container first, so the playbook stops changing hosts and writing events
    // before the redaction pass below reads them; the process then ends by itself.
    await stopStarted(spec);
    execution.terminate();
  };
  const onAbort = () => void stop();
  if (request.signal?.aborted) onAbort();
  else request.signal?.addEventListener('abort', onAbort, { once: true });
  const release = hooks.started?.(stop);
  const rc = await execution.exit;
  release?.();
  request.signal?.removeEventListener('abort', onAbort);
  clearInterval(ticker);
  await following?.stop();
  await tail.stop();
  if (remote) await removeRunDir(remote, runDir);

  await dropVars(runDir).catch(() => undefined);
  await hooks.ended?.();
  let text = '';
  try {
    text = await readFile(eventsFile, 'utf8');
    // The kept events hold no secret input value either (the output now comes with them).
    if (hidden.length > 0) {
      text = redactText(text, hidden);
      await writeFile(eventsFile, text, 'utf8');
    }
  } catch {}
  const summary = summarizeRun(text, code.routes);
  hooks.finished?.({ stopped, rc, events: !!text.trim(), summary });
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
  if (request.audit)
    await appendAudit(request.storage, {
      event: 'finish',
      run: id,
      rc,
      ms: Date.now() - t0,
      hosts: summary.hosts.length,
      failed: Object.keys(summary.outcome).length + summary.failures.length,
    });
  // AFD-245: kept with its events, so the run can be shown again later.
  await keepRun(runDir, done);
  hooks.report(done);
  return done;
}

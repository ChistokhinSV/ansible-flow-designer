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
import { modelOf } from '../../core/flow/model';
import { nodeDesigns } from '../../core/flow/semantic';
import type { FlowDocument, Ulid } from '../../core/flow/types';
import type { RunView } from '../../core/protocol';
import {
  type ProcessSpec,
  type RepositoryConfig,
  runProcess,
  splitInputs,
} from '../../core/run/command';
import type { Environment } from '../../core/run/environment';
import { createSummarizer, type RunSummary, summarizeRun } from '../../core/run/events';
import { redactLine, redactText, secretValues } from '../../core/run/redact';
import {
  answer,
  type FailureFilters,
  hasSettings,
  type InspectAnswer,
  type InspectArgs,
  type InspectOp,
  inspectRequest,
  normalPoints,
  type PointSpec,
  pointNode,
  type RunStep,
  STEP_CONTROL,
  type StepCommand,
  type StepControl,
  type StepPause,
  startControl,
  stepEvent,
  stepState,
  stoppedLine,
} from '../../core/run/step';
import { followRunFile, putRunFile, removeRunDir, syncWorkspace } from '../ssh/remote';
import { appendAudit } from './audit';
import { type Execution, startProcess } from './exec';
import { type Inspector, localInspector, sshInspector } from './inspect';
import { keepRun, runsDir } from './pastRuns';
import { writeControl } from './stepChannel';
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
  callbacks?: RepositoryConfig;
  /** AFD-341: record each step's input values (default); false turns it off for this run. */
  recordInputs?: boolean;
  /** AFD-244: the run is of a part of the flow; its code is in a folder of its own. */
  partial?: RunView['partial'];
  /** AFD-247: paths the SSH copy needs that Git does not list (a partial run's folder). */
  syncAlso?: string[];
  /** What the audit log says about the launch, besides the run's id. Never input values. */
  audit?: Record<string, unknown>;
  /** Stops the run when it aborts. */
  signal?: AbortSignal;
  /**
   * AFD-346 (ADR-0039): run step by step: pause before every step (`every`) or only at `points`;
   * a pause nobody answers for `timeoutS` stops the run. `control` is the control to start with
   * (a later approval segment: the one the segment before had); `inside` the step it starts in.
   * ADR-0040: `debug` makes it a debug run (AFD_DEBUG=1): points with settings, inspect requests,
   * and a pause on failure as `failures` says (a host failed: on by default).
   */
  step?: {
    every: boolean;
    points: PointSpec[];
    timeoutS: number;
    control?: StepControl;
    inside?: Ulid;
    debug?: boolean;
    failures?: FailureFilters;
  };
}

/** AFD-346: how the host drives a step-by-step run while it goes. */
export interface StepDriver {
  /**
   * Step, Continue, Pause, Stop or (at a failure pause of a debug run) Retry; resolves with why
   * it could not be sent, if it could not.
   */
  send(command: StepCommand): Promise<string | undefined>;
  /** New pause points (bare ids, or with settings in a debug run), for the next step boundary. */
  setPoints(points: PointSpec[]): Promise<string | undefined>;
  /** ADR-0040: which failures pause a debug run, from the next step on. */
  setFailures(failures: FailureFilters): Promise<string | undefined>;
  /** The pause the run waits at now. */
  paused(): StepPause | undefined;
  /** The control last written, with the hit counts so far (a later segment starts with it). */
  control(): StepControl;
  /**
   * ADR-0040 §2: a request about the pause the run waits at now (variables, evaluate, watch);
   * resolves with the run's answer, `{gone: true}` when no pause waits. Never rejects.
   */
  inspect(op: InspectOp, args?: InspectArgs): Promise<InspectAnswer>;
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
  /**
   * The run started; `stop` ends it, `step` drives a step-by-step run. Returns what to call when
   * the run has ended.
   */
  started?(stop: () => Promise<void>, step?: StepDriver): (() => void) | undefined;
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
  // AFD-346: the control the run reads at its first step boundary, there before the process is.
  // ADR-0040: a debug run's failure filters go with every control written.
  const debug = !!request.step?.debug;
  let failures: FailureFilters | undefined = debug
    ? (request.step?.control?.failures ?? request.step?.failures ?? { failed: true })
    : undefined;
  let control: StepControl | undefined = request.step
    ? {
        ...(request.step.control ??
          startControl(request.step.every, normalPoints(request.step.points))),
        ...(failures ? { failures } : {}),
      }
    : undefined;
  const writeStep = async (c: StepControl): Promise<string | undefined> => {
    try {
      if (remote) return await putRunFile(remote, runDir, STEP_CONTROL, JSON.stringify(c), true);
      await writeControl(runDir, c);
      return undefined;
    } catch (e) {
      return `Could not write ${STEP_CONTROL}: ${e instanceof Error ? e.message : String(e)}`;
    }
  };
  if (control) {
    const failed = await writeStep(control);
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
      ...(request.recordInputs === false ? { recordInputs: false } : {}),
      ...(request.step
        ? {
            step: {
              timeoutS: request.step.timeoutS,
              ...(request.step.inside ? { inside: request.step.inside } : {}),
              ...(debug ? { debug: true } : {}),
            },
          }
        : {}),
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
  // AFD-346: the step events so far, and what they say (paused where, stopped where).
  const stepEvents: Record<string, unknown>[] = [];
  let points = normalPoints(request.step?.points ?? []);
  const pointsView = () => {
    const settings = points.filter(hasSettings);
    return {
      points: points.map(pointNode),
      ...(settings.length ? { settings } : {}),
      ...(debug ? { debug: true } : {}),
    };
  };
  const stepView = (): RunStep | undefined =>
    request.step
      ? { ...stepState(stepEvents), every: request.step.every, ...pointsView() }
      : undefined;
  const tail = tailFile(eventsFile, (lines) => {
    for (const line of lines) {
      live.push(redactLine(line, hidden));
      const e = request.step ? stepEvent(line) : undefined;
      if (e) stepEvents.push(e);
    }
    lastEvent = Date.now();
    changed = true;
    quiet = false;
  });
  const ticker = setInterval(() => {
    const step = stepView();
    // A run paused for its driver is not quiet: it waits for Step, Continue or Stop.
    if (step?.paused) lastEvent = Date.now();
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
      ...(step ? { step } : {}),
    });
  }, LIVE_MS);
  // ADR-0040: how the run goes on after a Retry (as the driver went before it).
  let going: 'step' | 'continue' =
    (control?.command === 'retry' ? control.after : control?.command) === 'continue'
      ? 'continue'
      : 'step';
  const withRun = (c: StepControl): StepControl => {
    const hits = stepState(stepEvents).hits ?? request.step?.control?.hits;
    return {
      ...c,
      ...(failures ? { failures } : {}),
      ...(hits && Object.keys(hits).length ? { hits: { ...hits } } : {}),
    };
  };
  let inspector: Inspector | undefined;
  let asked = 0;
  const driver: StepDriver | undefined = request.step
    ? {
        send: async (command) => {
          const paused = stepState(stepEvents).paused;
          // Pause is for a run that goes; a paused one waits already.
          if (command === 'pause' && paused) return undefined;
          if (command === 'retry') {
            if (paused?.kind !== 'failure')
              return 'Retry is offered only where hosts failed a step';
            if (paused.retryRefused) return paused.retryRefused;
            control = withRun({ ...answer('retry', points, paused.id), after: going });
            return writeStep(control);
          }
          if (command === 'step' || command === 'continue') going = command;
          control = withRun(answer(command, points, paused?.id));
          return writeStep(control);
        },
        setPoints: async (next) => {
          points = normalPoints(next);
          changed = true;
          control = withRun({ ...(control ?? startControl(false)), points });
          return writeStep(control);
        },
        setFailures: async (next) => {
          if (!debug) return 'Pause on failure needs a debug run';
          failures = { ...next };
          control = withRun({ ...(control ?? startControl(false)), points });
          return writeStep(control);
        },
        paused: () => stepState(stepEvents).paused,
        control: () => withRun(control ?? startControl(false, points)),
        inspect: async (op, args = {}) => {
          const paused = stepState(stepEvents).paused;
          if (!debug) return { error: 'Variables and evaluate need a debug run' };
          if (!paused) return { gone: true };
          if (paused.debug === false) return { error: paused.why ?? 'The run cannot be debugged' };
          inspector ??= remote ? sshInspector(remote, runDir) : localInspector(runDir);
          asked += 1;
          return inspector.ask(asked, inspectRequest(asked, paused.id, op, args));
        },
      }
    : undefined;

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
  const release = hooks.started?.(stop, driver);
  const rc = await execution.exit;
  inspector?.close();
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
  // AFD-346: the whole file read again: a stopped event the tail had not reached counts too.
  const step: RunStep | undefined = request.step
    ? {
        ...stepState(
          text
            .split('\n')
            .map(stepEvent)
            .filter((e): e is Record<string, unknown> => !!e),
        ),
        every: request.step.every,
        ...pointsView(),
      }
    : undefined;
  // A step-by-step run stopped at a step boundary exits 2: it was stopped, it did not fail.
  const stepStopped = step?.stopped;
  const stoppedAt = stepStopped?.node;
  const title = stoppedAt ? (modelOf(doc).nodes.get(stoppedAt)?.node.title ?? stoppedAt) : '';
  if (step) delete step.paused;
  hooks.finished?.({ stopped: stopped || !!stepStopped, rc, events: !!text.trim(), summary });
  const done: RunView = {
    ...running,
    state: rc === undefined || stopped || stepStopped ? 'error' : 'done',
    finishedAt: new Date().toISOString(),
    rc,
    summary,
    error: stepStopped
      ? stoppedLine(stepStopped, title, request.step?.timeoutS ?? 0)
      : stopped
        ? 'Stopped by the user'
        : rc === undefined
          ? 'The run could not be started'
          : text
            ? undefined
            : 'The run produced no events',
    ...(stopped || stepStopped ? { errorCode: 'cancelled' as const } : {}),
    ...(stoppedAt ? { stoppedAt } : {}),
    ...(step ? { step } : {}),
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

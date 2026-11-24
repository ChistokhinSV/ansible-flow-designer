// VS Code's debugger for flows (ADR-0040 §8, AFD-369): a Debug Adapter Protocol adapter over one
// debug run. It speaks the protocol itself (VS Code runs it inline, no adapter library), and knows
// the run only through its host: a StepDriver to send commands and ask a paused run (inspect),
// and the run's views as they come. No vscode import: the unit tests drive it with a fake driver.
// - Threads: one per host, host name first ("edge-02 · failed"); before the first pause, one
//   thread for the run.
// - A pause is one `stopped` event with allThreadsStopped, on the first failed or matching host.
// - Stack frames: the step and the subflows around it, on their `key:` lines in the .flow.yaml.
// - Scopes: Step inputs, Host variables, Flow data, Facts (expensive); variables paged.
// - Evaluate (Debug Console, Watch) runs the run's evaluate; refusals come back as text.
// - Breakpoints: function breakpoints "<flow key>:<step key path>", source breakpoints on a
//   step's `key:` line; condition, hit count and log message are a pause point's settings.
//   Exception filters "Host failed" and "Host unreachable" are the failure filters.
// - Retry: a custom request `retry` (DAP has none), offered by the designer's step bar too.
import { basename } from 'node:path';
import { keyPath } from '../../core/ai/refs';
import { pausableNode } from '../../core/flow/canvasMenu';
import { buildModel, type FlowModel, ROOT } from '../../core/flow/model';
import type { FlowDocument, Ulid } from '../../core/flow/types';
import type { RunView } from '../../core/protocol';
import {
  entryText,
  failedLines,
  keyLines,
  maskedText,
  pointFromBreakpoint,
  readBreakpointName,
  reasonLine,
  retryWarning,
  shortReason,
  stepByPath,
  valueText,
} from '../../core/run/debug';
import {
  type FailureFilters,
  type InspectAnswer,
  normalPoints,
  type PointSpec,
  pointNode,
  type StepCommand,
  type StepPause,
  stepPath,
  type VarEntry,
  type VarScope,
} from '../../core/run/step';
import type { StepDriver } from '../run/runFlow';

/** The launch configuration's arguments (type `ansible-flow`). */
export interface DebugLaunchArgs {
  /** The .flow.yaml to debug. */
  flow?: string;
  mode?: 'check' | 'real';
  /** Pause before the first step (otherwise at pause points and failures only). */
  stopOnEntry?: boolean;
  /** Flow input values; the host asks for missing ones. */
  inputs?: Record<string, unknown>;
  /** A launch the designer's dialog prepared (its answers, kept by the host, never in the config). */
  launch?: string;
}

export interface DebugFlow {
  path: string;
  text: string;
  doc: FlowDocument;
}

export interface DebugRunHooks {
  every: boolean;
  points: PointSpec[];
  failures: FailureFilters;
  started(driver: StepDriver): void;
  report(run: RunView): void;
}

/** What the adapter needs of the editor around it. */
export interface DebugHost {
  /** Reads the flow to debug. */
  load(args: DebugLaunchArgs): Promise<DebugFlow | { error: string }>;
  /** Runs it as a debug run; resolves with the run's last view. */
  start(args: DebugLaunchArgs, hooks: DebugRunHooks): Promise<RunView>;
  /** Ends the run going (it is not paused). */
  stop(): Promise<void>;
  /** Two file paths name the same file (case-insensitive on Windows). */
  samePath(a: string, b: string): boolean;
  /**
   * The flow's pause points as the designer keeps them. DAP's function breakpoints carry no log
   * message: a log point mirrored there gets its message back from here.
   */
  savedPoints?(): PointSpec[];
  /**
   * The Breakpoints view's Host failed and Host unreachable filters, as VS Code sends them: kept
   * as the flow's failure filters, so the designer's Edit Pause Point shows the same.
   */
  keepFailures?(failures: Required<FailureFilters>): void;
}

type Json = Record<string, unknown>;
interface Request {
  seq: number;
  type: 'request';
  command: string;
  arguments?: Json;
}

/** The thread before the first pause, when no host is known yet. */
const RUN_THREAD = 1;
/** How long a disconnect waits for the run to end before it answers. */
const END_WAIT_MS = 20_000;

type Producer =
  | { kind: 'remote'; host: string; scope: VarScope; path: (string | number)[] }
  | { kind: 'value'; value: unknown };

interface Frame {
  host: string;
  node: Ulid;
}

const EVAL_REFUSED = /not allowed/i;
const STEP_OUT =
  'Step Out is not there yet: Step (F10) runs the step and pauses before the next one; Continue (F5) runs on to the next pause point.';

export class FlowDebugAdapter {
  private seq = 1;
  private args: DebugLaunchArgs = {};
  private flow?: DebugFlow;
  private model?: FlowModel;
  private lines = new Map<Ulid, number>();
  private nodeAtLine = new Map<number, Ulid>();
  private fnPoints = new Map<Ulid, { spec: PointSpec; id: number }>();
  private srcPoints = new Map<Ulid, { spec: PointSpec; id: number }>();
  private failures: FailureFilters = { failed: true, unreachable: false };
  private nextBp = 1;
  private driver?: StepDriver;
  private view?: RunView;
  private running?: Promise<void>;
  private ended = false;
  private stoppedAt?: string;
  private threadIds = new Map<string, number>();
  private nextThread = RUN_THREAD + 1;
  private handles = new Map<number, Producer>();
  private frames = new Map<number, Frame>();
  private nextHandle = 1;
  private seenLogs = new Set<string>();
  private seenRefused?: string;

  constructor(
    private readonly host: DebugHost,
    private readonly sendMessage: (message: Json) => void,
  ) {}

  // ---- protocol plumbing ----------------------------------------------------------------------

  private send(m: Json): void {
    this.sendMessage({ seq: this.seq++, ...m });
  }

  private respond(req: Request, body: Json = {}): void {
    this.send({
      type: 'response',
      request_seq: req.seq,
      command: req.command,
      success: true,
      body,
    });
  }

  private refuse(req: Request, message: string): void {
    this.send({
      type: 'response',
      request_seq: req.seq,
      command: req.command,
      success: false,
      message,
      body: { error: { id: 1, format: message, showUser: false } },
    });
  }

  private event(event: string, body: Json = {}): void {
    this.send({ type: 'event', event, body });
  }

  private output(
    text: string,
    category: 'console' | 'stdout' | 'stderr' | 'important' = 'console',
  ) {
    this.event('output', { category, output: `${text}\n` });
  }

  /** One protocol message from VS Code. Never throws: a failure is a failed response. */
  async handle(message: Json): Promise<void> {
    if (message.type !== 'request') return;
    const req = message as unknown as Request;
    try {
      await this.dispatch(req);
    } catch (e) {
      this.refuse(req, e instanceof Error ? e.message : String(e));
    }
  }

  private async dispatch(req: Request): Promise<void> {
    const a = req.arguments ?? {};
    switch (req.command) {
      case 'initialize':
        return this.respond(req, {
          supportsConfigurationDoneRequest: true,
          supportsFunctionBreakpoints: true,
          supportsConditionalBreakpoints: true,
          supportsHitConditionalBreakpoints: true,
          supportsLogPoints: true,
          supportsExceptionInfoRequest: true,
          supportsDelayedStackTraceLoading: true,
          supportsTerminateRequest: true,
          supportsEvaluateForHovers: false,
          exceptionBreakpointFilters: [
            {
              filter: 'failed',
              label: 'Host failed',
              default: true,
              description: 'Pause where a host fails a step (Retry, Continue or Stop)',
            },
            {
              filter: 'unreachable',
              label: 'Host unreachable',
              default: false,
              description: 'Pause where a host cannot be reached',
            },
          ],
        });
      case 'launch':
        return this.launch(req, a as DebugLaunchArgs);
      case 'setBreakpoints':
        return this.setBreakpoints(req, a);
      case 'setFunctionBreakpoints':
        return this.setFunctionBreakpoints(req, a);
      case 'setExceptionBreakpoints': {
        const filters = Array.isArray(a.filters) ? a.filters.map(String) : [];
        this.failures = {
          failed: filters.includes('failed'),
          unreachable: filters.includes('unreachable'),
        };
        this.host.keepFailures?.({
          failed: this.failures.failed === true,
          unreachable: this.failures.unreachable === true,
        });
        const error = this.driver ? await this.driver.setFailures(this.failures) : undefined;
        if (error) this.output(error, 'stderr');
        return this.respond(req, { breakpoints: filters.map(() => ({ verified: true })) });
      }
      case 'configurationDone':
        this.respond(req);
        this.start();
        return;
      case 'threads':
        return this.respond(req, { threads: this.threads() });
      case 'stackTrace':
        return this.respond(req, this.stackTrace(a));
      case 'scopes':
        return this.respond(req, { scopes: await this.scopes(Number(a.frameId)) });
      case 'variables':
        return this.respond(req, { variables: await this.variables(a) });
      case 'evaluate':
        return this.evaluate(req, a);
      case 'exceptionInfo':
        return this.exceptionInfo(req);
      case 'continue':
        return this.command(req, 'continue', { allThreadsContinued: true });
      case 'next':
        return this.command(req, 'step');
      case 'pause':
        return this.command(req, 'pause');
      case 'retry':
        return this.command(req, 'retry');
      // DAP cannot hide Step Into: in a flow it is Step, which also pauses before the first step
      // inside a subflow.
      case 'stepIn':
        return this.command(req, 'step');
      // Not there yet: said in the Debug Console (a refused request is a pop-up). VS Code takes
      // an answered step request as the run going on: the pause is told again.
      case 'stepOut':
      case 'stepBack':
      case 'reverseContinue':
        return this.notThere(req);
      case 'afd/frame': {
        const frame = this.frames.get(Number(a.frameId));
        return this.respond(req, frame ? { node: frame.node } : {});
      }
      case 'disconnect':
      case 'terminate':
        return this.end(req);
      default:
        return this.respond(req);
    }
  }

  // ---- launch, the run ------------------------------------------------------------------------

  private async launch(req: Request, args: DebugLaunchArgs): Promise<void> {
    this.args = args;
    const flow = await this.host.load(args);
    if ('error' in flow) return this.refuse(req, flow.error);
    this.flow = flow;
    this.model = buildModel(flow.doc);
    this.lines = keyLines(flow.text, this.model);
    this.nodeAtLine = new Map([...this.lines].map(([id, line]) => [line, id]));
    this.respond(req);
    this.event('initialized');
  }

  /** The points VS Code's breakpoints make, one per step. */
  points(): PointSpec[] {
    const out = new Map<Ulid, PointSpec>();
    for (const [node, p] of this.fnPoints) out.set(node, p.spec);
    // A breakpoint on the step's line in the file adds its settings when the other has none.
    for (const [node, p] of this.srcPoints)
      if (!out.has(node) || typeof out.get(node) === 'string') out.set(node, p.spec);
    return normalPoints([...out.values()]);
  }

  private async pushPoints(): Promise<void> {
    if (!this.driver) return;
    const error = await this.driver.setPoints(this.points());
    if (error) this.output(error, 'stderr');
  }

  private start(): void {
    if (!this.flow) {
      this.event('terminated');
      return;
    }
    this.output(
      `Debugging ${this.flow.doc.flow.name} (${this.args.mode === 'real' ? 'real run' : 'check mode'})`,
    );
    this.running = this.host
      .start(this.args, {
        every: this.args.stopOnEntry === true,
        points: this.points(),
        failures: this.failures,
        started: (driver) => {
          this.driver = driver;
        },
        report: (view) => this.report(view),
      })
      .then(
        (view) => this.finish(view),
        (e) => this.finish(undefined, e instanceof Error ? e.message : String(e)),
      );
  }

  private finish(view: RunView | undefined, error?: string): void {
    if (this.ended) return;
    this.ended = true;
    if (view) this.report(view);
    const words =
      error ?? (view?.state === 'done' ? 'The run ended' : (view?.error ?? 'The run ended'));
    this.output(words, view?.state === 'done' ? 'console' : 'stderr');
    this.event('exited', { exitCode: view?.rc ?? (view?.state === 'done' ? 0 : 1) });
    this.event('terminated');
  }

  private async end(req: Request): Promise<void> {
    if (this.running && !this.ended) {
      if (this.driver?.paused()) await this.driver.send('stop');
      else await this.host.stop();
      await Promise.race([this.running, new Promise((r) => setTimeout(r, END_WAIT_MS))]);
    }
    this.respond(req);
    if (!this.running && !this.ended) {
      this.ended = true;
      this.event('terminated');
    }
  }

  private notThere(req: Request): void {
    this.output(STEP_OUT);
    this.respond(req);
    const pause = this.paused();
    if (pause) this.stopped(pause, true);
  }

  private async command(req: Request, command: StepCommand, body: Json = {}): Promise<void> {
    if (!this.driver) return this.refuse(req, 'The run has not started yet');
    const error = await this.driver.send(command);
    if (error) {
      this.output(error, 'important');
      return this.refuse(req, error);
    }
    this.respond(req, body);
  }

  // ---- what the run says ----------------------------------------------------------------------

  private title(id: Ulid): string {
    return this.model ? stepPath(this.model, id) : id;
  }

  /** The pause the run waits at now. */
  private paused(): StepPause | undefined {
    return this.view?.state === 'running' ? this.view.step?.paused : undefined;
  }

  /** A view of the run: log lines to the Debug Console, a new pause as `stopped`. */
  report(view: RunView): void {
    this.view = view;
    const step = view.step;
    for (const l of step?.logs ?? []) {
      const key = `${l.ts}|${l.node}|${l.host ?? ''}|${l.message ?? l.error ?? ''}`;
      if (this.seenLogs.has(key)) continue;
      this.seenLogs.add(key);
      const where = `${this.title(l.node)}${l.host ? ` · ${l.host}` : ''}`;
      if (l.error)
        this.output(
          `${where}: the ${l.source === 'condition' ? 'condition' : 'log message'} failed: ${l.error}`,
          'stderr',
        );
      else this.output(`${where}: ${l.message ?? ''}`, 'stdout');
    }
    if (step?.refused && step.refused.pause !== this.seenRefused) {
      this.seenRefused = step.refused.pause;
      this.output(step.refused.why, 'important');
    }
    const pause = this.paused();
    if (pause && pause.id !== this.stoppedAt) {
      this.stoppedAt = pause.id;
      this.handles.clear();
      this.frames.clear();
      this.stopped(pause);
    } else if (!pause && this.stoppedAt && view.state === 'running') {
      this.stoppedAt = undefined;
      this.event('continued', { threadId: RUN_THREAD, allThreadsContinued: true });
    }
  }

  private threadOf(host: string): number {
    let id = this.threadIds.get(host);
    if (id === undefined) {
      id = this.nextThread++;
      this.threadIds.set(host, id);
    }
    return id;
  }

  private hostOf(thread: number): string | undefined {
    for (const [host, id] of this.threadIds) if (id === thread) return host;
    return undefined;
  }

  /** The hosts of a pause: all hosts wait; failed ones first. */
  private hostsOf(pause: StepPause): string[] {
    const failed = (pause.failed ?? []).map((f) => f.host);
    return [...new Set([...failed, ...(pause.matched ?? []), ...pause.hosts])];
  }

  /** `again`: the same pause told again (after Step Out), without its lines in the console. */
  private stopped(pause: StepPause, again = false): void {
    const title = this.title(pause.node);
    const first = this.hostsOf(pause)[0];
    const reason =
      pause.kind === 'failure'
        ? 'exception'
        : pause.kind === 'point' || pause.kind === 'condition'
          ? 'breakpoint'
          : (this.view?.step?.pauses ?? 0) <= 1 && this.args.stopOnEntry
            ? 'entry'
            : 'step';
    const point = this.fnPoints.get(pause.node) ?? this.srcPoints.get(pause.node);
    const lines = [reasonLine(pause, title, !!point), ...failedLines(pause)];
    if (pause.kind === 'failure') lines.push(this.retryText(pause, title));
    if (pause.debug === false && pause.why) lines.push(`Variables are not shown: ${pause.why}`);
    if (!again) this.output(lines.join('\n'), pause.kind === 'failure' ? 'important' : 'console');
    this.event('stopped', {
      reason,
      description: shortReason(pause, title),
      text: lines.join('\n'),
      threadId: first ? this.threadOf(first) : RUN_THREAD,
      allThreadsStopped: true,
      ...(point && reason === 'breakpoint' ? { hitBreakpointIds: [point.id] } : {}),
    });
  }

  private retryText(pause: StepPause, title: string): string {
    // The run's words are whole sentences: said once, with one full stop.
    return pause.retryRefused
      ? `Retry is not offered here: ${pause.retryRefused.replace(/\.+$/, '')}.`
      : `${retryWarning(pause, title)} Retry: the Retry button in the designer's step bar, or the command Retry Failed Step.`;
  }

  private threads(): Json[] {
    const pause = this.paused();
    if (!pause) {
      if (this.threadIds.size === 0)
        return [{ id: RUN_THREAD, name: this.flow?.doc.flow.name ?? 'Flow run' }];
      return [...this.threadIds].map(([host, id]) => ({ id, name: `${host} · running` }));
    }
    const failed = new Map((pause.failed ?? []).map((f) => [f.host, f]));
    const matched = new Set(pause.matched ?? []);
    return this.hostsOf(pause).map((host) => {
      const f = failed.get(host);
      const state = f
        ? f.unreachable
          ? 'unreachable'
          : 'failed'
        : matched.has(host)
          ? 'matched'
          : 'waiting';
      return { id: this.threadOf(host), name: `${host} · ${state}` };
    });
  }

  private stackTrace(a: Json): Json {
    const pause = this.paused();
    const host = this.hostOf(Number(a.threadId));
    if (!pause || !host || !this.model || !this.flow) return { stackFrames: [], totalFrames: 0 };
    const source = { name: basename(this.flow.path), path: this.flow.path };
    const failed = pause.failed?.find((f) => f.host === host);
    const chain: Ulid[] = [];
    for (let id: Ulid | undefined = pause.node; id; ) {
      chain.push(id);
      const level: string | undefined = this.model.nodes.get(id)?.level;
      id = level && level !== ROOT ? level : undefined;
    }
    const all: Json[] = chain.map((node, i) => {
      const frameId = this.nextHandle++;
      this.frames.set(frameId, { host, node });
      return {
        id: frameId,
        // An unreachable host's frame says so, as its thread does.
        name: `${this.title(node)}${i === 0 && failed ? (failed.unreachable ? '  (unreachable)' : '  (failed)') : ''}`,
        source,
        line: this.lines.get(node) ?? 1,
        column: 1,
      };
    });
    const top = this.nextHandle++;
    this.frames.set(top, { host, node: pause.node });
    all.push({
      id: top,
      name: `${this.flow.doc.flow.name} (flow)`,
      source,
      line: 1,
      column: 1,
      presentationHint: 'subtle',
    });
    const start = Number(a.startFrame ?? 0);
    const levels = Number(a.levels ?? 0) || all.length;
    return { stackFrames: all.slice(start, start + levels), totalFrames: all.length };
  }

  private ref(p: Producer): number {
    const id = this.nextHandle++;
    this.handles.set(id, p);
    return id;
  }

  private async ask(op: 'scopes' | 'vars' | 'eval', args: Json): Promise<InspectAnswer> {
    if (!this.driver) return { error: 'The run has not started yet' };
    const answer = await this.driver.inspect(op, args);
    if (answer.gone) return { error: 'The run went on: this pause is over' };
    return answer;
  }

  private async scopes(frameId: number): Promise<Json[]> {
    const frame = this.frames.get(frameId);
    if (!frame || !this.paused()) return [];
    const answer = await this.ask('scopes', { host: frame.host });
    if (answer.error) {
      this.output(`${frame.host}: ${answer.error}`, 'stderr');
      return [];
    }
    return (answer.scopes ?? []).map((s) => ({
      name: s.id === 'host' || s.id === 'inputs' ? `${s.name} (${frame.host})` : s.name,
      presentationHint:
        s.id === 'inputs'
          ? 'arguments'
          : s.id === 'host'
            ? 'locals'
            : s.id === 'facts'
              ? 'registers'
              : undefined,
      variablesReference: this.ref({ kind: 'remote', host: frame.host, scope: s.id, path: [] }),
      expensive: !!s.expensive,
      ...(s.vars ? { namedVariables: s.vars.length } : {}),
    }));
  }

  /** A variable for VS Code from an entry of an answer. */
  private variable(e: VarEntry, child: Producer | undefined): Json {
    const container = e.type === 'dict' || e.type === 'list';
    return {
      name: String(e.name),
      value: entryText(e),
      type: e.type === 'masked' ? maskedText(e.masked) : e.type,
      variablesReference: container && child ? this.ref(child) : 0,
      ...(container && e.type === 'list' ? { indexedVariables: e.count ?? 0 } : {}),
      ...(container && e.type === 'dict' ? { namedVariables: e.count ?? 0 } : {}),
      ...(e.type === 'masked' ? { presentationHint: { attributes: ['readOnly'] } } : {}),
    };
  }

  private async variables(a: Json): Promise<Json[]> {
    const p = this.handles.get(Number(a.variablesReference));
    if (!p || !this.paused()) return [];
    if (p.kind === 'value') return this.valueChildren(p.value, a);
    const asked = typeof a.count === 'number' && a.count > 0;
    let start = Number(a.start ?? 0);
    const want = asked ? Number(a.count) : 5000;
    const out: Json[] = [];
    while (out.length < want) {
      const answer = await this.ask('vars', {
        host: p.host,
        scope: p.scope,
        path: p.path,
        start,
        count: Math.min(1000, want - out.length),
      });
      if (answer.error) {
        out.push({ name: 'error', value: answer.error, variablesReference: 0 });
        break;
      }
      const children = answer.children ?? [];
      if (p.scope === 'facts' && p.path.length === 0 && start === 0 && children.length === 0) {
        out.push({
          name: '(none)',
          value: 'No facts for this host yet: a step that gathers facts has not run on it',
          variablesReference: 0,
        });
        break;
      }
      for (const e of children)
        out.push(
          this.variable(e, {
            kind: 'remote',
            host: p.host,
            scope: p.scope,
            path: [...p.path, e.name],
          }),
        );
      start += children.length;
      if (!answer.more || children.length === 0) break;
    }
    return out;
  }

  /** The items of a value an evaluate returned whole (a dict or a list). */
  private valueChildren(value: unknown, a: Json): Json[] {
    const items: [string | number, unknown][] = Array.isArray(value)
      ? value.map((v, i) => [i, v])
      : value && typeof value === 'object'
        ? Object.entries(value)
        : [];
    const start = Number(a.start ?? 0);
    const count = typeof a.count === 'number' && a.count > 0 ? a.count : items.length;
    return items.slice(start, start + count).map(([name, v]) => {
      const marker = !!v && typeof v === 'object' && '__afd__' in (v as Json);
      const container = !marker && !!v && typeof v === 'object';
      return {
        name: String(name),
        value: valueText(v),
        variablesReference: container ? this.ref({ kind: 'value', value: v }) : 0,
        ...(container && Array.isArray(v) ? { indexedVariables: v.length } : {}),
      };
    });
  }

  private async evaluate(req: Request, a: Json): Promise<void> {
    const context = String(a.context ?? 'repl');
    const pause = this.paused();
    if (!pause) return this.refuse(req, 'Evaluate works while the run is paused');
    const frame = this.frames.get(Number(a.frameId));
    const host = frame?.host ?? this.hostsOf(pause)[0];
    if (!host) return this.refuse(req, 'No host waits at this pause');
    // `{{ x }}` as typed in a flow is the expression x.
    const expr = String(a.expression ?? '')
      .trim()
      .replace(/^\{\{\s*([\s\S]*?)\s*\}\}$/, '$1');
    if (!expr) return this.refuse(req, 'Type a Jinja expression, as in a when: (no {{ }})');
    const answer = await this.ask('eval', { host, expr });
    if (answer.error || answer.timeout) {
      const words = answer.timeout
        ? 'Took longer than 2 s: stopped'
        : answer.refused || EVAL_REFUSED.test(answer.error ?? '')
          ? `Refused: ${answer.error}`
          : `Error: ${answer.error}`;
      // A watch shows its error inline; the console shows it as text.
      if (context === 'watch') return this.refuse(req, words);
      return this.respond(req, { result: words, variablesReference: 0 });
    }
    const container = answer.type === 'dict' || answer.type === 'list';
    const result = entryText({ ...answer, type: answer.type ?? 'str' } as VarEntry);
    this.respond(req, {
      result:
        container && answer.value !== undefined && !answer.cut ? valueText(answer.value) : result,
      type: answer.type,
      variablesReference:
        container && answer.value !== undefined && !answer.cut
          ? this.ref({ kind: 'value', value: answer.value })
          : 0,
    });
  }

  private exceptionInfo(req: Request): void {
    const pause = this.paused();
    if (pause?.kind !== 'failure') {
      this.refuse(req, 'No host failed at this pause');
      return;
    }
    const title = this.title(pause.node);
    const unreachable = !!pause.failed?.length && pause.failed.every((f) => f.unreachable);
    this.respond(req, {
      exceptionId: unreachable ? 'unreachable' : 'failed',
      description: reasonLine(pause, title),
      breakMode: 'always',
      details: {
        message: [...failedLines(pause), this.retryText(pause, title)].join('\n'),
        typeName: unreachable ? 'Host unreachable' : 'Host failed',
      },
    });
  }

  // ---- breakpoints ----------------------------------------------------------------------------

  private setBreakpoints(req: Request, a: Json): Promise<void> {
    const source = (a.source ?? {}) as { path?: string };
    const asked = Array.isArray(a.breakpoints) ? (a.breakpoints as Json[]) : [];
    const ours = !!this.flow && !!source.path && this.host.samePath(source.path, this.flow.path);
    if (!ours) {
      return Promise.resolve(
        this.respond(req, {
          breakpoints: asked.map((b) => ({
            verified: false,
            line: b.line,
            message: this.flow
              ? `Not the flow being debugged (${basename(this.flow.path)})`
              : 'No flow is being debugged',
          })),
        }),
      );
    }
    this.srcPoints.clear();
    const out = asked.map((b) => {
      const line = Number(b.line);
      const node = this.nodeAtLine.get(line);
      const entry = node ? this.model?.nodes.get(node)?.node : undefined;
      if (!node || !entry)
        return {
          verified: false,
          line,
          message: "A breakpoint in a flow goes on a step's key: line",
        };
      if (!pausableNode(entry))
        return {
          verified: false,
          line,
          message:
            'A run pauses before a step: not at start, an end or a subflow (put it on a step inside)',
        };
      const made = pointFromBreakpoint(
        node,
        b as { condition?: string; hitCondition?: string; logMessage?: string },
      );
      if ('error' in made) return { verified: false, line, message: made.error };
      const id = this.nextBp++;
      this.srcPoints.set(node, { spec: this.withSavedLog(made.point), id });
      return { id, verified: true, line, source };
    });
    this.respond(req, { breakpoints: out });
    return this.pushPoints();
  }

  /**
   * A breakpoint with no log message keeps the log message of the designer's point at its step:
   * VS Code sends none for a function breakpoint, and a log point read as a plain one paused the
   * run and wrote nothing.
   */
  private withSavedLog(spec: PointSpec): PointSpec {
    if (typeof spec !== 'string' && spec.log?.trim()) return spec;
    const node = pointNode(spec);
    const saved = this.host.savedPoints?.().find((p) => pointNode(p) === node);
    if (!saved || typeof saved === 'string' || !saved.log?.trim()) return spec;
    return { ...(typeof spec === 'string' ? { node } : spec), log: saved.log };
  }

  private setFunctionBreakpoints(req: Request, a: Json): Promise<void> {
    const asked = Array.isArray(a.breakpoints) ? (a.breakpoints as Json[]) : [];
    this.fnPoints.clear();
    const out = asked.map((b) => {
      const named = readBreakpointName(String(b.name ?? ''));
      if (!this.flow || !this.model)
        return { verified: false, message: 'No flow is being debugged' };
      const key = this.flow.doc.flow.key;
      if (named.flow && named.flow !== key)
        return {
          verified: false,
          message: `A step of flow ${named.flow}; this session debugs ${key}`,
        };
      const node = stepByPath(this.model, named.path);
      if (!node)
        return {
          verified: false,
          message: `No step ${named.path} in ${key} where a run can pause`,
        };
      const made = pointFromBreakpoint(
        node,
        b as { condition?: string; hitCondition?: string; logMessage?: string },
      );
      if ('error' in made) return { verified: false, message: made.error };
      const id = this.nextBp++;
      this.fnPoints.set(node, { spec: this.withSavedLog(made.point), id });
      return {
        id,
        verified: true,
        source: { name: basename(this.flow.path), path: this.flow.path },
        line: this.lines.get(node),
      };
    });
    this.respond(req, { breakpoints: out });
    return this.pushPoints();
  }
}

/** A step's breakpoint name in this flow (for VS Code's function breakpoints). */
export function stepBreakpointName(model: FlowModel, flowKey: string, node: Ulid): string {
  return `${flowKey}:${keyPath(model, node)}`;
}

/** The node ids a set of points names (for tests and the host). */
export const pointNodes = (points: readonly PointSpec[]): Ulid[] => points.map(pointNode);

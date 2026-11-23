// VS Code's debugger for flows (ADR-0040 §8, AFD-369): the `ansible-flow` debug type around the
// inline adapter (node/debug/adapter.ts), and what ties it to the designer:
// - Run ▾ › Debug (the launch dialog) and launch configurations start a debug session; the
//   dialog's answers (inputs, the vault password) stay here, never in the configuration;
// - a flow's pause points are mirrored as function breakpoints "<flow key>:<step key path>", both
//   ways (the canvas and the Breakpoints view);
// - the canvas follows the selected stack frame.
import { resolve } from 'node:path';
import * as vscode from 'vscode';
import { keyPath } from '../../core/ai/refs';
import { parseFlow } from '../../core/flow/document';
import { buildModel } from '../../core/flow/model';
import type { FlowDocument } from '../../core/flow/types';
import {
  breakpointName,
  breakpointOf,
  pointFromBreakpoint,
  readBreakpointName,
  stepByPath,
} from '../../core/run/debug';
import { normalPoints, type PointSpec, pointNode } from '../../core/run/step';
import {
  type DebugFlow,
  type DebugHost,
  type DebugLaunchArgs,
  FlowDebugAdapter,
} from '../../node/debug/adapter';
import type { Host } from '../host';
import { type RunOptions, runFlow } from '../run/runner';
import { onPausePointsChanged, pointSpecs, pointsFromBreakpoints } from '../run/stepRun';
import { stopRun } from '../run/stop';

export const DEBUG_TYPE = 'ansible-flow';

/** The launch dialog's answers for a debug session about to start, by a one-time id. */
const prepared = new Map<string, Omit<RunOptions, 'debug'>>();
let preparedSerial = 0;

const samePath = (a: string, b: string): boolean => {
  const norm = (p: string) => resolve(p).replaceAll('\\', '/');
  return process.platform === 'win32'
    ? norm(a).toLowerCase() === norm(b).toLowerCase()
    : norm(a) === norm(b);
};

function flowOf(text: string): FlowDocument | undefined {
  return parseFlow(text).doc;
}

/**
 * Starts a debug session of `uri`: with the launch dialog's answers (Run ▾ › Debug), or asking
 * for inputs as Run does (a command with no designer open).
 */
export async function debugFlow(
  uri: vscode.Uri,
  options: Omit<RunOptions, 'debug'>,
  stopOnEntry = false,
): Promise<boolean> {
  const id = `l${++preparedSerial}`;
  prepared.set(id, options);
  const text = (await vscode.workspace.openTextDocument(uri)).getText();
  const name = flowOf(text)?.flow.name ?? 'flow';
  await reconcile(uri);
  const started = await vscode.debug.startDebugging(vscode.workspace.getWorkspaceFolder(uri), {
    type: DEBUG_TYPE,
    request: 'launch',
    name: `Debug ${name}`,
    flow: uri.fsPath,
    mode: options.mode,
    stopOnEntry,
    launch: id,
  });
  if (!started) prepared.delete(id);
  return started;
}

/** The adapter's host: reads the flow, runs it as a debug run, stops it. */
function adapterHost(host: Host, session: vscode.DebugSession): DebugHost {
  let flowUri: vscode.Uri | undefined;
  return {
    async load(args: DebugLaunchArgs): Promise<DebugFlow | { error: string }> {
      const given = args.flow ? vscode.Uri.file(args.flow) : undefined;
      const doc = await host.resolveTargetFlow(given, { quiet: true });
      if (!doc?.uri.path.endsWith('.flow.yaml'))
        return { error: 'Debug a flow: open a .flow.yaml, or name it in the configuration (flow)' };
      const text = doc.getText();
      const flow = flowOf(text);
      if (!flow?.flow)
        return { error: `${doc.uri.fsPath} does not read as a flow: fix its YAML first` };
      flowUri = doc.uri;
      return { path: doc.uri.fsPath, text, doc: flow };
    },
    async start(args, hooks) {
      if (!flowUri) throw new Error('No flow loaded');
      const doc = await vscode.workspace.openTextDocument(flowUri);
      const given = args.launch ? prepared.get(args.launch) : undefined;
      if (args.launch) prepared.delete(args.launch);
      const options: RunOptions = {
        mode: given?.mode ?? (args.mode === 'real' ? 'real' : 'check'),
        ...(given ?? (args.inputs ? { inputs: args.inputs } : {})),
        debug: hooks,
      };
      const run = await runFlow(doc, host.runDeps(doc.uri), options);
      void session;
      return run;
    },
    async stop() {
      if (flowUri) await stopRun(flowUri);
    },
    samePath,
  };
}

class InlineAdapter implements vscode.DebugAdapter {
  private readonly emitter = new vscode.EventEmitter<vscode.DebugProtocolMessage>();
  readonly onDidSendMessage = this.emitter.event;
  private readonly adapter: FlowDebugAdapter;
  constructor(host: DebugHost) {
    this.adapter = new FlowDebugAdapter(host, (m) => this.emitter.fire(m));
  }
  handleMessage(message: vscode.DebugProtocolMessage): void {
    void this.adapter.handle(message as Record<string, unknown>);
  }
  dispose(): void {
    this.emitter.dispose();
  }
}

// ---- pause points as function breakpoints ---------------------------------------------------

/** Breakpoints this side added or removed: their change events are not the person's. */
const own = new Set<string>();

const flowBreakpoints = (flowKey: string): vscode.FunctionBreakpoint[] =>
  vscode.debug.breakpoints.filter(
    (b): b is vscode.FunctionBreakpoint =>
      b instanceof vscode.FunctionBreakpoint && readBreakpointName(b.functionName).flow === flowKey,
  );

async function flowAt(uri: vscode.Uri): Promise<FlowDocument | undefined> {
  try {
    return flowOf((await vscode.workspace.openTextDocument(uri)).getText());
  } catch {
    return undefined;
  }
}

/** Replaces a flow's function breakpoints with its pause points. */
function mirror(doc: FlowDocument, points: readonly PointSpec[]): void {
  const model = buildModel(doc);
  const old = flowBreakpoints(doc.flow.key);
  const made = points
    .filter((p) => model.nodes.has(pointNode(p)))
    .map((p) => {
      const s = breakpointOf(p);
      return new vscode.FunctionBreakpoint(
        breakpointName(doc.flow.key, keyPath(model, pointNode(p))),
        true,
        s.condition,
        s.hitCondition,
        s.logMessage,
      );
    });
  // Unchanged: nothing to do (and no event to tell apart).
  const sig = (b: vscode.FunctionBreakpoint) =>
    [b.functionName, b.enabled, b.condition ?? '', b.hitCondition ?? '', b.logMessage ?? ''].join(
      '|',
    );
  const a = old.map(sig).sort().join('\n');
  const b = made.map(sig).sort().join('\n');
  if (a === b) return;
  for (const x of [...old, ...made]) own.add(x.id);
  if (old.length) vscode.debug.removeBreakpoints(old);
  if (made.length) vscode.debug.addBreakpoints(made);
}

/** A flow's points as its function breakpoints say (enabled ones). */
function fromBreakpoints(doc: FlowDocument): PointSpec[] {
  const model = buildModel(doc);
  const out: PointSpec[] = [];
  for (const b of flowBreakpoints(doc.flow.key)) {
    if (!b.enabled) continue;
    const node = stepByPath(model, readBreakpointName(b.functionName).path);
    if (!node) continue;
    const made = pointFromBreakpoint(node, b);
    if ('point' in made) out.push(made.point);
  }
  return normalPoints(out);
}

let hostRef: Host | undefined;

/** Before a debug session: the canvas's points and the Breakpoints view's, both kept. */
async function reconcile(uri: vscode.Uri): Promise<void> {
  const doc = await flowAt(uri);
  if (!doc || !hostRef) return;
  const state = hostRef.context.workspaceState;
  const kept = pointSpecs(state, doc.flow.id);
  const seen = new Set(kept.map(pointNode));
  const both = [...kept, ...fromBreakpoints(doc).filter((p) => !seen.has(pointNode(p)))];
  await pointsFromBreakpoints(state, uri, doc.flow.id, both);
  mirror(doc, both);
  await hostRef.sessions.get(uri.toString())?.showPausePoints();
}

/** The Breakpoints view changed a flow's function breakpoints: its pause points follow. */
async function breakpointsChanged(e: vscode.BreakpointsChangeEvent): Promise<void> {
  const host = hostRef;
  if (!host) return;
  const keys = new Set<string>();
  for (const b of [...e.added, ...e.removed, ...e.changed]) {
    if (own.delete(b.id)) continue;
    if (!(b instanceof vscode.FunctionBreakpoint)) continue;
    const flow = readBreakpointName(b.functionName).flow;
    if (flow) keys.add(flow);
  }
  if (!keys.size) return;
  for (const session of host.sessions.values()) {
    const doc = (await session.snapshot()).doc;
    if (!doc || !keys.has(doc.flow.key)) continue;
    await pointsFromBreakpoints(
      host.context.workspaceState,
      session.uri,
      doc.flow.id,
      fromBreakpoints(doc),
    );
    await session.showPausePoints();
  }
}

export function registerDebugger(host: Host): vscode.Disposable[] {
  hostRef = host;
  return [
    vscode.debug.registerDebugAdapterDescriptorFactory(DEBUG_TYPE, {
      createDebugAdapterDescriptor(session) {
        return new vscode.DebugAdapterInlineImplementation(
          new InlineAdapter(adapterHost(host, session)),
        );
      },
    }),
    vscode.debug.registerDebugConfigurationProvider(DEBUG_TYPE, {
      // F5 with no launch.json, or a configuration without its flow: the flow in front.
      async resolveDebugConfiguration(_folder, config) {
        const uri = host.targetUri();
        if (!config.type && !config.request && !config.name) {
          if (!uri?.path.endsWith('.flow.yaml')) return config;
          return {
            type: DEBUG_TYPE,
            request: 'launch',
            name: 'Debug flow',
            flow: uri.fsPath,
            mode: 'check',
          };
        }
        if (!config.flow && uri) config.flow = uri.fsPath;
        if (config.flow) await reconcile(vscode.Uri.file(String(config.flow)));
        return config;
      },
    }),
    onPausePointsChanged(async ({ flow }) => {
      const doc = await flowAt(flow);
      if (doc) mirror(doc, pointSpecs(host.context.workspaceState, doc.flow.id));
    }),
    vscode.debug.onDidChangeBreakpoints((e) => void breakpointsChanged(e).catch(() => undefined)),
    // The canvas shows the step of the frame picked in Call Stack.
    vscode.debug.onDidChangeActiveStackItem(async (item) => {
      if (!(item instanceof vscode.DebugStackFrame) || item.session.type !== DEBUG_TYPE) return;
      const flow = item.session.configuration.flow;
      if (typeof flow !== 'string') return;
      try {
        const r = (await item.session.customRequest('afd/frame', { frameId: item.frameId })) as {
          node?: string;
        };
        const session = [...host.sessions.values()].find((s) => samePath(s.uri.fsPath, flow));
        if (r?.node && session) session.reveal(r.node);
      } catch {
        // The session ended meanwhile.
      }
    }),
  ];
}

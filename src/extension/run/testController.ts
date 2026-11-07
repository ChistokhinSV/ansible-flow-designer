// Scenarios in VS Code's Testing view (AFD-118): a flow with a scenarios file is an item, its
// scenarios are children at their `name` lines. Two run profiles: Check (the simulation, instant,
// the default) and Verify in Ansible (Run Scenarios, every step its stub). A failing scenario's
// messages sit on the `expect` lines of the hosts that ended elsewhere.
import { basename } from 'node:path';
import * as vscode from 'vscode';
import { parseFlow, rangeOf } from '../../core/flow/document';
import { parseScenarios, type ScenarioResult } from '../../core/scenario/scenarios';
import { missText, scenarioMisses } from '../../core/scenario/view';
import { parseYaml } from '../../core/yaml/parse';
import { CMD } from '../commands/ids';
import type { Host } from '../host';
import { flowOf, rangeIn, textOf } from './scenarioLive';

const SUFFIX = '.scenarios.yaml';

export type ScenarioRunKind = 'check' | 'ansible';

/** What one scenario came to, for a test run (and the tests of the Testing view itself). */
export interface ScenarioOutcome {
  name: string;
  state: 'passed' | 'failed' | 'errored' | 'skipped';
  /** Each miss in words, with where it points in the scenarios file. */
  messages: { text: string; range?: vscode.Range }[];
  /** A simulated verdict the simulator gives as a best effort. */
  bestEffort?: string;
}

/** Ranges of a scenario's name and of each host's expectation, from the file as it reads now. */
function places(text: string | undefined) {
  if (!text) return { name: () => undefined, expect: () => undefined };
  const yaml = parseYaml(text);
  const at = (path: (string | number)[]) => {
    const [start, end] = rangeOf(yaml, path);
    return rangeIn(text, start, end);
  };
  return {
    name: (i: number) => at(['scenarios', i, 'name']),
    expect: (i: number, host: string) => at(['scenarios', i, 'expect', host]),
  };
}

export class ScenarioTests implements vscode.Disposable {
  readonly controller = vscode.tests.createTestController(
    'afd.scenarios',
    'Ansible Flow Scenarios',
  );
  private readonly disposables: vscode.Disposable[];

  constructor(private readonly host: Host) {
    const c = this.controller;
    c.resolveHandler = async (item) => {
      if (!item) await this.discover();
    };
    c.refreshHandler = () => this.discover();
    c.createRunProfile(
      'Check (simulated)',
      vscode.TestRunProfileKind.Run,
      (request, token) => this.runRequest(request, token, 'check'),
      true,
    );
    c.createRunProfile(
      'Verify in Ansible',
      vscode.TestRunProfileKind.Run,
      (request, token) => this.runRequest(request, token, 'ansible'),
      false,
    );
    const watcher = vscode.workspace.createFileSystemWatcher(`**/*${SUFFIX}`);
    this.disposables = [
      c,
      watcher,
      watcher.onDidCreate((uri) => void this.update(flowOf(uri))),
      watcher.onDidChange((uri) => void this.update(flowOf(uri))),
      watcher.onDidDelete((uri) => c.items.delete(flowOf(uri).toString())),
      // A scenario added on the canvas or by a tool shows at once.
      ...(host.scenarioLive
        ? [host.scenarioLive.onDidCheck(({ flow }) => void this.update(flow))]
        : []),
    ];
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
  }

  /** Every flow with a scenarios file. */
  async discover(): Promise<void> {
    const files = await vscode.workspace.findFiles(`**/*${SUFFIX}`, '**/node_modules/**', 500);
    await Promise.all(files.map((f) => this.update(flowOf(f))));
  }

  /** A flow's item and its scenarios as the files read now; none when it has no scenarios. */
  async update(flow: vscode.Uri): Promise<vscode.TestItem | undefined> {
    const flowText = await textOf(flow);
    const doc = flowText === undefined ? undefined : parseFlow(flowText).doc;
    const key = doc?.flow?.key ?? basename(flow.path).replace(/\.flow\.yaml$/, '');
    const uri = vscode.Uri.joinPath(flow, '..', `${key}${SUFFIX}`);
    const text = await textOf(uri);
    if (!doc || text === undefined) {
      this.controller.items.delete(flow.toString());
      return undefined;
    }
    const id = flow.toString();
    const item =
      this.controller.items.get(id) ??
      this.controller.createTestItem(id, doc.flow.name || key, uri);
    item.description = vscode.workspace.asRelativePath(uri);
    this.controller.items.add(item);
    const file = parseScenarios(text).file;
    const at = places(text);
    const children = (file?.scenarios ?? [])
      .filter((s) => s && typeof s.name === 'string')
      .map((s, i) => {
        const child = this.controller.createTestItem(`${id}#${s.name}`, s.name, uri);
        child.range = at.name(i);
        return child;
      });
    item.children.replace(children);
    return item;
  }

  /** Runs some scenarios of a flow the way a profile does. */
  async outcomes(
    flow: vscode.Uri,
    names: readonly string[] | undefined,
    kind: ScenarioRunKind,
  ): Promise<ScenarioOutcome[]> {
    const check = await this.host.scenarioLive?.refresh(flow);
    if (!check?.file) return [];
    const doc = parseFlow((await textOf(flow)) ?? '').doc ?? undefined;
    const at = places(await textOf(vscode.Uri.joinPath(flow, '..', `${doc?.flow?.key}${SUFFIX}`)));
    const wanted = (n: string) => !names || names.includes(n);
    let results: (ScenarioResult | undefined)[];
    if (kind === 'check')
      results = check.names.map((n, i) => (wanted(n) ? check.results[i] : undefined));
    else {
      const ran = await vscode.commands.executeCommand<ScenarioResult[] | undefined>(
        CMD.runScenarios,
        flow,
        check.names.filter(wanted),
      );
      results = check.names.map((n) => ran?.find((r) => r.name === n));
    }
    const out: ScenarioOutcome[] = [];
    check.names.forEach((name, i) => {
      if (!wanted(name)) return;
      const r = results[i];
      if (!r) {
        const why =
          check.error ??
          check.problems.find((p) => p.scenario === i && p.severity !== 'warning')?.message;
        out.push({
          name,
          state: why || kind === 'check' ? 'errored' : 'skipped',
          messages: [{ text: why ?? 'Not run', range: at.name(i) }],
        });
        return;
      }
      const best = r.needsAnsible?.map((u) => u.message).join('; ');
      if (r.error) {
        out.push({ name, state: 'errored', messages: [{ text: r.error, range: at.name(i) }] });
        return;
      }
      out.push({
        name,
        state: r.passed ? 'passed' : 'failed',
        messages: scenarioMisses(r).map((m) => ({
          text: `${kind === 'check' ? 'Simulated: ' : ''}${missText(doc, m)}`,
          range: at.expect(i, m.host),
        })),
        ...(best ? { bestEffort: best } : {}),
      });
    });
    return out;
  }

  private async runRequest(
    request: vscode.TestRunRequest,
    token: vscode.CancellationToken,
    kind: ScenarioRunKind,
  ): Promise<void> {
    const run = this.controller.createTestRun(request);
    // Per flow: the scenarios asked for (all when the flow itself is).
    const wanted = new Map<string, Set<string> | undefined>();
    const roots: vscode.TestItem[] = [];
    if (request.include) roots.push(...request.include);
    else
      this.controller.items.forEach((i) => {
        roots.push(i);
      });
    const excluded = new Set((request.exclude ?? []).map((i) => i.id));
    for (const item of roots) {
      if (excluded.has(item.id)) continue;
      const [flowId, name] = item.id.split('#', 2) as [string, string | undefined];
      if (!name) wanted.set(flowId, undefined);
      else if (!wanted.has(flowId) || wanted.get(flowId))
        wanted.set(flowId, new Set([...(wanted.get(flowId) ?? []), name]));
    }
    for (const [flowId, names] of wanted) {
      if (token.isCancellationRequested) break;
      const parent = this.controller.items.get(flowId);
      if (!parent) continue;
      const children: vscode.TestItem[] = [];
      parent.children.forEach((c) => {
        const name = c.id.slice(flowId.length + 1);
        if ((!names || names.has(name)) && !excluded.has(c.id)) children.push(c);
      });
      for (const c of children) run.started(c);
      const started = Date.now();
      const results = await this.outcomes(
        vscode.Uri.parse(flowId),
        children.map((c) => c.id.slice(flowId.length + 1)),
        kind,
      );
      const duration = Date.now() - started;
      for (const c of children) {
        const o = results.find((r) => r.name === c.id.slice(flowId.length + 1));
        const messages = (o?.messages ?? []).map((m) => {
          const message = new vscode.TestMessage(m.text);
          if (m.range && c.uri) message.location = new vscode.Location(c.uri, m.range);
          return message;
        });
        if (o?.bestEffort)
          run.appendOutput(
            `${c.label}: simulated as a best effort: ${o.bestEffort}\r\n`,
            undefined,
            c,
          );
        if (!o || o.state === 'skipped') run.skipped(c);
        else if (o.state === 'passed') run.passed(c, duration);
        else if (o.state === 'failed') run.failed(c, messages, duration);
        else run.errored(c, messages, duration);
      }
    }
    run.end();
  }
}

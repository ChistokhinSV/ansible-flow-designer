// The live scenario check in VS Code (AFD-115): about 200 ms after a flow or its scenarios file
// changes (the open buffers, unsaved edits included, else the files), the scenarios are checked and
// simulated (core/scenario/live.ts). Problems shows the file's errors and warnings and, on the
// `expect` line of each host that the simulation sends elsewhere, a warning; the flow gets a
// `scenario-miss` warning per failing scenario. The designer gets the whole check. Verdicts from
// Ansible (Run Scenarios) are kept per flow in workspace storage, with what they were made on.
import { basename } from 'node:path';
import * as vscode from 'vscode';
import { parseFlow, rangeOf } from '../../core/flow/document';
import type { FlowDocument } from '../../core/flow/types';
import {
  checkLive,
  type ScenarioCheck,
  type StoredVerdict,
  storedVerdict,
} from '../../core/scenario/live';
import type { Scenario, ScenarioResult } from '../../core/scenario/scenarios';
import { missText, scenarioMisses } from '../../core/scenario/view';
import { parseYaml } from '../../core/yaml/parse';
import type { Host } from '../host';
import { scenariosUri } from './scenarioFollow';

const SUFFIX = '.scenarios.yaml';
const FLOW = '.flow.yaml';
/** workspaceState: flow URI → scenario name → the last verdict from Ansible. */
const VERDICTS = 'afd.scenarioVerdicts';
const DELAY_MS = 200;

const isScenarios = (uri: vscode.Uri) => uri.path.endsWith(SUFFIX);
const isFlowUri = (uri: vscode.Uri) => uri.path.endsWith(FLOW);
/** The flow a scenarios file belongs to: `<key>.flow.yaml` beside it. */
const flowOf = (uri: vscode.Uri) =>
  vscode.Uri.joinPath(uri, '..', `${basename(uri.path).slice(0, -SUFFIX.length)}${FLOW}`);

async function textOf(uri: vscode.Uri): Promise<string | undefined> {
  const open = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
  if (open) return open.getText();
  try {
    return new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
  } catch {
    return undefined;
  }
}

/** Offsets of a YAML path as a Range, through a document when open, else by counting lines. */
function rangeIn(text: string, start: number, end: number): vscode.Range {
  const pos = (offset: number) => {
    const before = text.slice(0, offset);
    const line = before.split('\n').length - 1;
    return new vscode.Position(line, offset - (before.lastIndexOf('\n') + 1));
  };
  return new vscode.Range(pos(start), pos(end));
}

export class ScenarioLive implements vscode.Disposable {
  private readonly diagnostics = vscode.languages.createDiagnosticCollection('afd-scenarios');
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly disposables: vscode.Disposable[];
  /** The last check per flow URI (tests, the tools). */
  readonly checks = new Map<string, ScenarioCheck>();

  constructor(private readonly host: Host) {
    const watcher = vscode.workspace.createFileSystemWatcher(`**/*${SUFFIX}`);
    const touched = (uri: vscode.Uri) => {
      if (isScenarios(uri)) this.schedule(flowOf(uri));
      else if (isFlowUri(uri)) this.schedule(uri);
    };
    this.disposables = [
      this.diagnostics,
      watcher,
      watcher.onDidCreate(touched),
      watcher.onDidChange(touched),
      watcher.onDidDelete(touched),
      vscode.workspace.onDidOpenTextDocument((d) => touched(d.uri)),
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (e.contentChanges.length > 0) touched(e.document.uri);
      }),
      // Closed with unsaved edits, the file on disk is what counts again.
      vscode.workspace.onDidCloseTextDocument((d) => {
        if (isScenarios(d.uri)) this.schedule(flowOf(d.uri));
      }),
    ];
    for (const d of vscode.workspace.textDocuments) touched(d.uri);
  }

  dispose(): void {
    for (const t of this.timers.values()) clearTimeout(t);
    for (const d of this.disposables) d.dispose();
  }

  schedule(flow: vscode.Uri): void {
    const key = flow.toString();
    clearTimeout(this.timers.get(key));
    this.timers.set(
      key,
      setTimeout(() => {
        this.timers.delete(key);
        void this.refresh(flow);
      }, DELAY_MS),
    );
  }

  /** Checks a flow's scenarios now; undefined when the flow is not there or does not read. */
  async refresh(flow: vscode.Uri): Promise<ScenarioCheck | undefined> {
    const flowText = await textOf(flow);
    const doc = flowText === undefined ? undefined : parseFlow(flowText).doc;
    if (!doc?.flow?.key) return undefined;
    const uri = scenariosUri(flow, doc);
    const text = await textOf(uri);
    const check = checkLive(doc, text, this.verdicts(flow));
    this.checks.set(flow.toString(), check);
    this.publish(flow, flowText ?? '', doc, uri, text, check);
    this.host.sessions.get(flow.toString())?.setScenarioCheck(check);
    return check;
  }

  private publish(
    flow: vscode.Uri,
    flowText: string,
    doc: FlowDocument,
    uri: vscode.Uri,
    text: string | undefined,
    check: ScenarioCheck,
  ): void {
    if (text === undefined || !check.file) {
      this.diagnostics.delete(uri);
      this.diagnostics.delete(flow);
      return;
    }
    const yaml = parseYaml(text);
    const at = (path: (string | number)[]) => {
      const [start, end] = rangeOf(yaml, path);
      return rangeIn(text, start, end);
    };
    const diag = (range: vscode.Range, message: string, severity: vscode.DiagnosticSeverity) => {
      const d = new vscode.Diagnostic(range, message, severity);
      d.source = 'Ansible Flow';
      return d;
    };
    const out: vscode.Diagnostic[] = [];
    if (check.error)
      out.push(diag(new vscode.Range(0, 0, 0, 1), check.error, vscode.DiagnosticSeverity.Error));
    for (const p of check.problems)
      out.push(
        diag(
          at(p.path),
          p.message,
          p.severity === 'warning'
            ? vscode.DiagnosticSeverity.Warning
            : vscode.DiagnosticSeverity.Error,
        ),
      );
    const onFlow: vscode.Diagnostic[] = [];
    const flowYaml = parseYaml(flowText);
    const [fs, fe] = rangeOf(flowYaml, ['flow', 'key']);
    check.results.forEach((r, i) => {
      for (const u of r.needsAnsible ?? [])
        out.push(
          diag(
            at(['scenarios', i, 'name']),
            `Simulated as a best effort: ${u.message}. Run it in Ansible to be sure.`,
            vscode.DiagnosticSeverity.Information,
          ),
        );
      if (r.passed) return;
      if (r.error)
        out.push(
          diag(
            at(['scenarios', i, 'name']),
            `Simulated: ${r.error}`,
            vscode.DiagnosticSeverity.Warning,
          ),
        );
      const misses = scenarioMisses(r);
      for (const m of misses)
        out.push(
          diag(
            at(['scenarios', i, 'expect', m.host]),
            `Simulated: ${missText(doc, m)}`,
            vscode.DiagnosticSeverity.Warning,
          ),
        );
      const first = misses[0];
      const d = diag(
        rangeIn(flowText, fs, fe),
        `Scenario "${r.name}" fails (simulated)${first ? `: ${missText(doc, first)}` : r.error ? `: ${r.error}` : ''}`,
        vscode.DiagnosticSeverity.Warning,
      );
      d.code = 'scenario-miss';
      onFlow.push(d);
    });
    this.diagnostics.set(uri, out);
    this.diagnostics.set(flow, onFlow);
  }

  verdicts(flow: vscode.Uri): Record<string, StoredVerdict> {
    const all = this.host.context.workspaceState.get<Record<string, Record<string, StoredVerdict>>>(
      VERDICTS,
      {},
    );
    return all[flow.toString()] ?? {};
  }

  /** Keeps the verdicts of a Run Scenarios in Ansible, then checks again so the designer has them. */
  async remember(
    flow: vscode.Uri,
    doc: FlowDocument,
    scenarios: readonly Scenario[],
    results: readonly ScenarioResult[],
    at: string,
  ): Promise<void> {
    const state = this.host.context.workspaceState;
    const all = { ...state.get<Record<string, Record<string, StoredVerdict>>>(VERDICTS, {}) };
    const mine = { ...(all[flow.toString()] ?? {}) };
    for (const r of results) {
      const s = scenarios.find((x) => x.name === r.name);
      // A run that could not tell (cancelled, no events) is no verdict.
      if (s && !r.error) mine[r.name] = storedVerdict(doc, s, r, at);
    }
    // Only scenarios still in the file are kept.
    for (const name of Object.keys(mine))
      if (!scenarios.some((s) => s.name === name)) delete mine[name];
    all[flow.toString()] = mine;
    await state.update(VERDICTS, all);
    await this.refresh(flow);
  }
}

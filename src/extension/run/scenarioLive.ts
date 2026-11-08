// The live scenario check in VS Code (AFD-115): about 200 ms after a flow or its scenarios file
// changes (the open buffers, unsaved edits included, else the files), the scenarios are checked and
// simulated (core/scenario/live.ts). Problems shows the file's errors and warnings and, on the
// `expect` line of each host that the simulation sends elsewhere, a warning; the flow gets a
// `scenario-miss` warning per failing scenario. The designer gets the whole check. Verdicts from
// Ansible (Run Scenarios) are kept per flow in workspace storage, with what they were made on.
import { basename } from 'node:path';
import * as vscode from 'vscode';
import { parseFlow, rangeOf } from '../../core/flow/document';
import { isFileKey } from '../../core/flow/ids';
import type { FlowDocument } from '../../core/flow/types';
import {
  planScenarioEdit,
  ScenarioEditError,
  type ScenarioRequest,
} from '../../core/scenario/edit';
import {
  checkLive,
  type ScenarioCheck,
  type StoredVerdict,
  simulatedEnds,
  storedVerdict,
} from '../../core/scenario/live';
import type { Scenario, ScenarioResult } from '../../core/scenario/scenarios';
import { missText, scenarioMisses } from '../../core/scenario/view';
import { parseYaml } from '../../core/yaml/parse';
import type { CommandOutcome } from '../flowSession';
import type { Host } from '../host';
import { markTourKey, SCENARIO_ADDED } from '../tour';
import { scenariosUri } from './scenarioFollow';

const SUFFIX = '.scenarios.yaml';
const FLOW = '.flow.yaml';
/** workspaceState: flow URI → scenario name → the last verdict from Ansible. */
const VERDICTS = 'afd.scenarioVerdicts';
const DELAY_MS = 200;

const isScenarios = (uri: vscode.Uri) => uri.path.endsWith(SUFFIX);
const isFlowUri = (uri: vscode.Uri) => uri.path.endsWith(FLOW);
/** The flow a scenarios file belongs to: `<key>.flow.yaml` beside it. */
export const flowOf = (uri: vscode.Uri) =>
  vscode.Uri.joinPath(uri, '..', `${basename(uri.path).slice(0, -SUFFIX.length)}${FLOW}`);

export async function textOf(uri: vscode.Uri): Promise<string | undefined> {
  const open = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
  if (open) return open.getText();
  try {
    return new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
  } catch {
    return undefined;
  }
}

/** Offsets of a YAML path as a Range, through a document when open, else by counting lines. */
export function rangeIn(text: string, start: number, end: number): vscode.Range {
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
  /** AFD-118: each new check, for the Testing view's items. */
  private readonly checked = new vscode.EventEmitter<{ flow: vscode.Uri; check: ScenarioCheck }>();
  readonly onDidCheck = this.checked.event;
  /**
   * AFD-116: per flow URI, the scenarios file before each change made from the designer, newest
   * last; undefined where the change created the file. The canvas's Undo covers the flow only.
   */
  private readonly undos = new Map<string, (string | undefined)[]>();

  constructor(private readonly host: Host) {
    const watcher = vscode.workspace.createFileSystemWatcher(`**/*${SUFFIX}`);
    const touched = (uri: vscode.Uri) => {
      if (isScenarios(uri)) this.schedule(flowOf(uri));
      else if (isFlowUri(uri)) this.schedule(uri);
    };
    this.disposables = [
      this.diagnostics,
      this.checked,
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
    // AFD-133: a key that cannot name a file has no scenarios file to check.
    if (!doc || !isFileKey(doc.flow?.key)) return undefined;
    const uri = scenariosUri(flow, doc);
    const text = await textOf(uri);
    const check = checkLive(doc, text, this.verdicts(flow));
    this.checks.set(flow.toString(), check);
    this.checked.fire({ flow, check });
    this.publish(flow, flowText ?? '', doc, uri, text, check);
    this.host.sessions
      .get(flow.toString())
      ?.setScenarioCheck(check, this.undos.get(flow.toString())?.length ?? 0);
    return check;
  }

  /**
   * AFD-116: a change from the designer as one edit of the scenarios file, saved unless the file
   * had unsaved edits. `add` with no expectations and `acceptEnds` take the simulation's ends.
   */
  async edit(
    flow: vscode.Uri,
    doc: FlowDocument,
    request: ScenarioRequest,
  ): Promise<CommandOutcome> {
    if (!isFileKey(doc.flow?.key))
      return { ok: false, error: 'The flow key is not a lowercase slug: fix it first' };
    const uri = scenariosUri(flow, doc);
    const before = await textOf(uri);
    let cmd = request;
    if (request.kind === 'acceptEnds') {
      const s = this.checks.get(flow.toString())?.scenarios.find((x) => x.name === request.name);
      if (!s) return { ok: false, error: `No scenario named "${request.name}"` };
      cmd = { kind: 'setExpect', name: s.name, expect: simulatedEnds(doc, s) };
    } else if (request.kind === 'add' && Object.keys(request.scenario.expect ?? {}).length === 0)
      cmd = {
        ...request,
        scenario: { ...request.scenario, expect: simulatedEnds(doc, request.scenario) },
      };
    if (cmd.kind === 'acceptEnds') return { ok: false, error: 'Nothing to accept' };
    let plan: ReturnType<typeof planScenarioEdit>;
    try {
      plan = planScenarioEdit(before, cmd, doc);
    } catch (e) {
      if (e instanceof ScenarioEditError) return { ok: false, error: e.message };
      return { ok: false, error: 'The scenarios file does not read: fix it in the text editor' };
    }
    if (!plan.created && plan.edits.length === 0) return { ok: true };
    const edit = new vscode.WorkspaceEdit();
    let open: vscode.TextDocument | undefined;
    if (plan.created)
      edit.createFile(uri, {
        contents: new TextEncoder().encode(plan.text),
        ignoreIfExists: false,
      });
    else {
      open = await vscode.workspace.openTextDocument(uri);
      for (const e of plan.edits)
        edit.replace(
          uri,
          new vscode.Range(open.positionAt(e.start), open.positionAt(e.end)),
          e.newText,
        );
    }
    const wasDirty = open?.isDirty ?? false;
    if (!(await vscode.workspace.applyEdit(edit)))
      return { ok: false, error: 'VS Code rejected the edit' };
    if (open && !wasDirty) await open.save();
    if (cmd.kind === 'add') markTourKey(SCENARIO_ADDED);
    const stack = this.undos.get(flow.toString()) ?? [];
    stack.push(before);
    if (stack.length > 30) stack.shift();
    this.undos.set(flow.toString(), stack);
    await this.refresh(flow);
    return { ok: true };
  }

  /** AFD-116: takes back the last change made from the designer (a created file is deleted). */
  async undo(flow: vscode.Uri): Promise<CommandOutcome> {
    const stack = this.undos.get(flow.toString());
    if (!stack?.length) return { ok: false, error: 'No scenario change to undo' };
    const flowText = await textOf(flow);
    const doc = flowText === undefined ? undefined : parseFlow(flowText).doc;
    if (!doc || !isFileKey(doc.flow?.key))
      return { ok: false, error: 'The flow does not read: fix it first' };
    const uri = scenariosUri(flow, doc);
    const before = stack.pop();
    if (before === undefined) {
      // The change created the file: taking it back removes it. Not to the trash, which some
      // mounts lack (a WorkspaceEdit delete uses it and then fails).
      try {
        await vscode.workspace.fs.delete(uri, { useTrash: false });
      } catch (e) {
        if (!(e instanceof vscode.FileSystemError && e.code === 'FileNotFound'))
          return { ok: false, error: 'The scenarios file could not be removed' };
      }
    } else {
      const open = await vscode.workspace.openTextDocument(uri);
      const edit = new vscode.WorkspaceEdit();
      edit.replace(
        uri,
        new vscode.Range(open.positionAt(0), open.positionAt(open.getText().length)),
        before,
      );
      if (!(await vscode.workspace.applyEdit(edit)))
        return { ok: false, error: 'VS Code rejected the edit' };
      if (open.isDirty) await open.save();
    }
    await this.refresh(flow);
    return { ok: true };
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

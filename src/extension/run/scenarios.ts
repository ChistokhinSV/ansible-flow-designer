// Scenario tests in VS Code (AFD-58): Run Scenarios runs the flow's `<key>.scenarios.yaml` in the
// run environment (the same runner as the CI command line), offers a starter file when there is
// none, and the Problems panel checks scenario files against the flow next to them.
import { existsSync } from 'node:fs';
import { basename, join } from 'node:path';
import * as vscode from 'vscode';
import { parseFlow, rangeOf } from '../../core/flow/document';
import {
  checkScenarios,
  parseScenarios,
  type ScenarioResult,
  scenariosFileName,
  scenarioTemplate,
} from '../../core/scenario/scenarios';
import { parseYaml } from '../../core/yaml/parse';
import { describeResults, runScenarios } from '../../node/scenario/runner';
import { environmentFor } from '../env/environment';
import type { Host } from '../host';

const SUFFIX = '.scenarios.yaml';

/** Ansible Flow: Run Scenarios. Returns the results (tests), or undefined when nothing ran. */
export async function runScenariosCommand(
  host: Host,
  uri?: vscode.Uri,
  only?: readonly string[],
): Promise<ScenarioResult[] | undefined> {
  // From a scenarios file, its flow is the one next to it.
  const active = uri ?? vscode.window.activeTextEditor?.document.uri;
  const target = active?.fsPath.endsWith(SUFFIX)
    ? vscode.Uri.joinPath(
        active,
        '..',
        `${basename(active.fsPath).slice(0, -SUFFIX.length)}.flow.yaml`,
      )
    : uri;
  const text = await host.resolveTargetFlow(target);
  if (!text) return undefined;
  const doc = parseFlow(text.getText()).doc;
  if (!doc?.flow?.key) {
    void vscode.window.showErrorMessage('The flow does not parse: fix it before running scenarios');
    return undefined;
  }
  const folder = vscode.workspace.getWorkspaceFolder(text.uri);
  if (!folder) {
    void vscode.window.showErrorMessage('Open the flow inside a workspace folder to run scenarios');
    return undefined;
  }
  const file = vscode.Uri.joinPath(text.uri, '..', scenariosFileName(doc.flow.key));
  if (!existsSync(file.fsPath)) {
    const create = 'Create Scenarios File';
    const pick = await vscode.window.showInformationMessage(
      `${doc.flow.name} has no scenarios yet (${scenariosFileName(doc.flow.key)} next to the flow).`,
      create,
    );
    if (pick === create) {
      await vscode.workspace.fs.writeFile(file, new TextEncoder().encode(scenarioTemplate(doc)));
      await vscode.window.showTextDocument(file);
    }
    return undefined;
  }
  const parsed = parseScenarios(new TextDecoder().decode(await vscode.workspace.fs.readFile(file)));
  const problems = parsed.file ? checkScenarios(doc, parsed.file) : [];
  if (!parsed.file || problems.length > 0) {
    const open = 'Open Scenarios File';
    const pick = await vscode.window.showErrorMessage(
      `The scenarios do not fit the flow: ${parsed.error ?? problems[0]?.message}${problems.length > 1 ? ` (and ${problems.length - 1} more, see Problems)` : ''}`,
      open,
    );
    if (pick === open) await vscode.window.showTextDocument(file);
    return undefined;
  }
  const env = environmentFor(folder.uri);
  if (!env.ok) {
    void vscode.window.showErrorMessage(env.error);
    return undefined;
  }
  const scenarios = parsed.file;
  const results = await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `Run Scenarios: ${doc.flow.name} in ${env.env.label}`,
      cancellable: true,
    },
    (progress, token) => {
      const abort = new AbortController();
      token.onCancellationRequested(() => abort.abort());
      return runScenarios({
        env: env.env,
        root: folder.uri.fsPath,
        probeDir: host.probeDir,
        flowFile: text.uri.fsPath,
        doc,
        file: scenarios,
        workDir: join(host.storage.fsPath, 'scenarios', doc.flow.id ?? doc.flow.key),
        only,
        signal: abort.signal,
        log: (line) => {
          if (line.startsWith('# Scenario: ')) progress.report({ message: line.slice(12) });
          host.log.info(line);
        },
      });
    },
  );
  for (const line of describeResults(results)) host.log.info(line);
  const failed = results.filter((r) => !r.passed);
  const showLog = 'Show Log';
  const say = failed.length
    ? vscode.window.showWarningMessage(
        `Scenarios: ${failed.length} of ${results.length} failed: ${describeResults(failed).slice(0, 2).join('; ')}`,
        showLog,
      )
    : vscode.window.showInformationMessage(
        `Scenarios: all ${results.length} pass for ${doc.flow.name}.`,
        showLog,
      );
  void say.then((pick) => pick === showLog && host.log.show(true));
  return results;
}

/** Ansible Flow: Copy Scenario Runner — the CI command line into the repository, to commit. */
export async function copyScenarioRunner(host: Host, uri?: vscode.Uri): Promise<void> {
  const folder =
    (uri && vscode.workspace.getWorkspaceFolder(uri)) ?? vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    void vscode.window.showErrorMessage('Open a folder to copy the scenario runner into');
    return;
  }
  const target = vscode.Uri.joinPath(folder.uri, '.afd', 'afd-scenarios.js');
  await vscode.workspace.fs.copy(
    vscode.Uri.joinPath(host.context.extensionUri, 'dist', 'afd-scenarios.js'),
    target,
    { overwrite: true },
  );
  void vscode.window.showInformationMessage(
    'Copied .afd/afd-scenarios.js. In CI: node .afd/afd-scenarios.js --image <your EE image> --junit scenarios.xml flows',
  );
}

/** Problems for scenario files: names, ports, hosts and ends the flow next to them does not have. */
export function watchScenarioFiles(): vscode.Disposable {
  const diagnostics = vscode.languages.createDiagnosticCollection('afd-scenarios');
  const check = async (d: vscode.TextDocument) => {
    if (!d.fileName.endsWith(SUFFIX)) return;
    const key = basename(d.uri.fsPath).slice(0, -SUFFIX.length);
    const flow = vscode.Uri.joinPath(d.uri, '..', `${key}.flow.yaml`);
    if (!existsSync(flow.fsPath)) {
      diagnostics.set(d.uri, [
        new vscode.Diagnostic(
          new vscode.Range(0, 0, 0, 1),
          `No ${key}.flow.yaml next to this file: a scenarios file sits beside its flow`,
          vscode.DiagnosticSeverity.Warning,
        ),
      ]);
      return;
    }
    const doc = parseFlow(new TextDecoder().decode(await vscode.workspace.fs.readFile(flow))).doc;
    const parsed = parseScenarios(d.getText());
    if (!doc) return diagnostics.delete(d.uri);
    const yaml = parseYaml(d.getText());
    const problems = parsed.file
      ? checkScenarios(doc, parsed.file)
      : [{ scenario: -1, path: [], message: parsed.error ?? 'Not a scenarios file' }];
    diagnostics.set(
      d.uri,
      problems.map((p) => {
        const [start, end] = rangeOf(yaml, p.path);
        const diag = new vscode.Diagnostic(
          new vscode.Range(d.positionAt(start), d.positionAt(end)),
          p.message,
          vscode.DiagnosticSeverity.Error,
        );
        diag.source = 'Ansible Flow';
        return diag;
      }),
    );
  };
  for (const d of vscode.workspace.textDocuments) void check(d);
  return vscode.Disposable.from(
    diagnostics,
    vscode.workspace.onDidOpenTextDocument((d) => void check(d)),
    vscode.workspace.onDidChangeTextDocument((e) => void check(e.document)),
    vscode.workspace.onDidCloseTextDocument((d) => diagnostics.delete(d.uri)),
  );
}

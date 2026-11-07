// Scenario tests in VS Code (AFD-58): Run Scenarios runs the flow's `<key>.scenarios.yaml` in the
// run environment (the same runner as the CI command line) and offers a starter file when there is
// none. The live check and Problems are in scenarioLive.ts (AFD-115).
import { existsSync } from 'node:fs';
import { basename, join } from 'node:path';
import * as vscode from 'vscode';
import { parseFlow } from '../../core/flow/document';
import { stripAnsi } from '../../core/run/ansi';
import {
  blocking,
  checkScenarios,
  parseScenarios,
  type ScenarioResult,
  scenariosFileName,
  scenarioTemplate,
} from '../../core/scenario/scenarios';
import { missText, scenarioMisses } from '../../core/scenario/view';
import { describeResults, runScenarios } from '../../node/scenario/runner';
import { environmentFor } from '../env/environment';
import { showEnvironmentError } from '../env/setupEnvironment';
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
  const problems = parsed.file ? blocking(checkScenarios(doc, parsed.file)) : [];
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
    showEnvironmentError(env.error);
    return undefined;
  }
  const scenarios = parsed.file;
  const startedAt = new Date().toISOString();
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
        // The log channel shows escape codes as text: the run's colours are for a terminal.
        log: (raw) => {
          const line = stripAnsi(raw);
          if (line.startsWith('# Scenario: ')) progress.report({ message: line.slice(12) });
          host.log.info(line);
        },
      });
    },
  );
  for (const line of describeResults(results, doc)) host.log.info(line);
  // AFD-115: kept with the flow and scenario they ran on, for the designer and the next session.
  await host.scenarioLive?.remember(text.uri, doc, scenarios.scenarios, results, startedAt);
  const failed = results.filter((r) => !r.passed);
  // AFD-84: the designer's run panel lists the results; Show on Canvas opens the first failing one
  // there in Run mode. The notification stays one line (round 1: P18).
  host.sessions.get(text.uri.toString())?.showScenarios(results);
  const showCanvas = 'Show on Canvas';
  const showLog = 'Show Log';
  // AFD-94: the first miss in words, so the line answers "which host ended where" (round 2: S9).
  const first = failed[0];
  const miss = first ? scenarioMisses(first)[0] : undefined;
  // AFD-105: the panel's and the log's wording of a miss, so the three read the same.
  const why = miss
    ? `: ${missText(doc, miss)}`
    : first?.error
      ? ` (${first.name}: ${first.error})`
      : ` (first: ${first?.name})`;
  const say = failed.length
    ? vscode.window.showWarningMessage(
        `Scenarios: ${failed.length} of ${results.length} failed for ${doc.flow.name}${why}.`,
        showCanvas,
        showLog,
      )
    : vscode.window.showInformationMessage(
        `Scenarios: all ${results.length} pass for ${doc.flow.name}.`,
        showCanvas,
        showLog,
      );
  void say.then(async (pick) => {
    if (pick === showLog) host.log.show(true);
    if (pick !== showCanvas) return;
    if (!host.sessions.get(text.uri.toString())?.hasPanels) await host.openDesigner(text.uri);
    host.sessions.get(text.uri.toString())?.showScenarios(results, (failed[0] ?? results[0])?.name);
  });
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

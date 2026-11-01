// Run commands (AFD-37): skeleton and real runs, the syntax check, the audit log, the module
// catalog, and AWX (launch, template, token). Errors carry the command that fixes them.
import * as vscode from 'vscode';
import type { Notice, NoticeLevel, RunView } from '../../core/protocol';
import { runVerdict } from '../../core/run/view';
import { clearToken, launchInAwx, setToken, setupTemplate } from '../awx/awxRun';
import { isCancelled, showOutcomeError } from '../errors';
import type { Host } from '../host';
import { auditUri } from '../run/audit';
import { type RunOptions, runFlow } from '../run/runner';
import { copyScenarioRunner, runScenariosCommand } from '../run/scenarios';
import { stopRun } from '../run/stop';
import { syntaxCheck } from '../run/syntaxCheck';
import { CMD } from './ids';

type Quiet = { quiet?: boolean };

export function registerRunCommands(host: Host): vscode.Disposable[] {
  const run = async (mode: RunOptions['mode'], uri?: vscode.Uri) => {
    const doc = await host.resolveTargetFlow(uri);
    if (!doc) return undefined;
    const result = await runFlow(doc, host.runDeps(doc.uri), { mode });
    if (result.state === 'error')
      void showOutcomeError(result.error ?? 'The run failed', result.errorCode, doc.uri);
    else if (result.state === 'done') void announceRun(result);
    return result;
  };
  return [
    vscode.commands.registerCommand(CMD.runSkeleton, (uri?: vscode.Uri) => run('check', uri)),
    // Scenario tests (AFD-58); `only` names scenarios (tests).
    vscode.commands.registerCommand(
      CMD.runScenarios,
      (uri?: vscode.Uri, only?: readonly string[]) => runScenariosCommand(host, uri, only),
    ),
    vscode.commands.registerCommand(CMD.copyScenarioRunner, (uri?: vscode.Uri) =>
      copyScenarioRunner(host, uri),
    ),
    vscode.commands.registerCommand(CMD.runReal, (uri?: vscode.Uri) => run('real', uri)),
    vscode.commands.registerCommand(CMD.stopRun, async (uri?: vscode.Uri) => {
      const outcome = await stopRun(host.targetUri(uri));
      if (outcome === 'none') void vscode.window.showInformationMessage('No run is going.');
      else if (outcome === 'which')
        void vscode.window.showInformationMessage(
          'Several flows are running: open the one to stop, then Stop Run.',
        );
    }),
    vscode.commands.registerCommand(CMD.checkFlow, async (uri?: vscode.Uri, opts?: Quiet) => {
      const doc = await host.resolveTargetFlow(uri);
      if (!doc) return undefined;
      // `quiet`: the designer says it over its canvas (AFD-46); the outcome is returned either way.
      const tell = (level: NoticeLevel, text: string, show: (t: string) => unknown): Notice => {
        if (!opts?.quiet) void show(text);
        return { level, text };
      };
      // Check Flow (AFD-41) folds Validate Design and Check Generated Code: the design first, and
      // the generated code in the environment only when the design has no errors.
      await host.sessionFor(doc).refresh();
      const problems = vscode.languages.getDiagnostics(doc.uri);
      const errors = problems.filter((d) => d.severity === vscode.DiagnosticSeverity.Error).length;
      if (problems.length > 0)
        await vscode.commands.executeCommand('workbench.actions.view.problems');
      if (errors > 0)
        return tell(
          'error',
          `The design has ${errors} error${errors === 1 ? '' : 's'} (see Problems): the generated code is checked once they are fixed.`,
          (t) => vscode.window.showWarningMessage(t),
        );
      // A cancellable progress (AFD-39): the check can take minutes in a cold environment.
      const outcome = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: 'Check Flow: the generated code in the environment',
          cancellable: true,
        },
        (_progress, token) => {
          const abort = new AbortController();
          token.onCancellationRequested(() => abort.abort());
          return syntaxCheck(
            doc,
            host.deps.schema,
            host.probes,
            host.codeDiagnostics,
            abort.signal,
          );
        },
      );
      const design = problems.length
        ? `The design has no errors (${problems.length} warning${problems.length === 1 ? '' : 's'})`
        : 'The design has no problems';
      if (outcome.ok)
        return tell('success', `${design}. ${outcome.message}.`, (t) =>
          vscode.window.showInformationMessage(t),
        );
      if (isCancelled(outcome.message)) return undefined;
      return tell('error', `${design}. ${outcome.message}`, (t) =>
        vscode.window.showErrorMessage(t),
      );
    }),
    vscode.commands.registerCommand(CMD.showAudit, async () => {
      try {
        await vscode.window.showTextDocument(auditUri(host.storage), { preview: false });
      } catch {
        void vscode.window.showInformationMessage('No run has been launched yet.');
      }
    }),
    vscode.commands.registerCommand(CMD.rebuildCatalog, async (uri?: vscode.Uri) => {
      const scope = host.scopeUri(uri);
      const folder = scope && vscode.workspace.getWorkspaceFolder(scope);
      if (!folder) return void vscode.window.showErrorMessage('Open a repository folder first.');
      try {
        await host.catalog.ready(folder, true);
        const s = host.catalog.status(folder);
        void vscode.window.showInformationMessage(
          `Ansible catalog rebuilt: ${s.plugins ?? 0} plugins from ${s.collections ?? 0} collections.`,
        );
      } catch (err) {
        void vscode.window.showErrorMessage(err instanceof Error ? err.message : String(err));
      }
    }),
    vscode.commands.registerCommand(CMD.awxLaunch, async (uri?: vscode.Uri) => {
      const doc = await host.resolveTargetFlow(uri);
      if (!doc) return undefined;
      const result = await launchInAwx(doc, host.awxDeps(doc.uri));
      if (result.state === 'error')
        await showOutcomeError(result.error ?? 'The AWX run failed', result.errorCode, doc.uri);
      else if (result.state === 'done') void announceRun(result);
      return result;
    }),
    vscode.commands.registerCommand(CMD.awxSetupTemplate, async (uri?: vscode.Uri) => {
      const doc = await host.resolveTargetFlow(uri);
      if (!doc) return;
      const r = await setupTemplate(doc, host.awxDeps(doc.uri));
      if (r.ok) {
        const survey =
          r.survey === 'written'
            ? ' Its survey asks for the flow inputs.'
            : r.survey === 'kept'
              ? ' Its survey stays as edited in AWX.'
              : '';
        void vscode.window.showInformationMessage(
          `AWX job template "${r.template}" is ready; the flow now launches it.${survey}`,
        );
      } else if (!isCancelled(r.error))
        void vscode.window.showErrorMessage(r.error ?? 'Setting up the AWX template failed');
    }),
    vscode.commands.registerCommand(CMD.awxSetToken, async (uri?: vscode.Uri) => {
      const scope = host.scopeUri(uri);
      if (!scope) return;
      const error = await setToken(scope, host.context.secrets);
      if (error && !isCancelled(error)) void vscode.window.showErrorMessage(error);
    }),
    vscode.commands.registerCommand(CMD.awxClearToken, async (uri?: vscode.Uri) => {
      const scope = host.scopeUri(uri);
      if (scope) await clearToken(scope, host.context.secrets);
    }),
  ];
}

/** The outcome of a finished run, with a way to its output. */
async function announceRun(run: RunView): Promise<void> {
  const s = run.summary;
  const { ok, failed } = runVerdict(run);
  const what = run.awx
    ? `AWX job #${run.awx.jobId} (${run.awx.status})`
    : run.mode === 'check'
      ? 'Skeleton run (check mode)'
      : 'Run';
  const text = s?.stoppedEarly
    ? `${what} stopped early (exit ${run.rc}): see the ${run.awx ? 'job output' : 'terminal'}`
    : `${what} finished (exit ${run.rc}): ${s?.hosts.length ?? 0} host(s), ${failed} failed`;
  const show = run.awx ? 'Open in AWX' : 'Show Terminal';
  const pick = await (ok
    ? vscode.window.showInformationMessage(text, show)
    : vscode.window.showWarningMessage(text, show));
  if (pick !== show) return;
  if (run.awx) await vscode.env.openExternal(vscode.Uri.parse(run.awx.url));
  else await vscode.commands.executeCommand('workbench.action.terminal.focus');
}

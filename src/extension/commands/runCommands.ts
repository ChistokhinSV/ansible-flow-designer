// Run commands (AFD-37): skeleton and real runs, the syntax check, the audit log, the module
// catalog, and AWX (launch, template, token). Errors carry the command that fixes them.
import * as vscode from 'vscode';
import type { RunView } from '../../core/protocol';
import { runVerdict } from '../../core/run/view';
import { clearToken, launchInAwx, setToken, setupTemplate } from '../awx/awxRun';
import { isCancelled, showOutcomeError } from '../errors';
import type { Host } from '../host';
import { auditUri } from '../run/audit';
import { type RunOptions, runFlow } from '../run/runner';
import { syntaxCheck } from '../run/syntaxCheck';

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
    vscode.commands.registerCommand('afd.runSkeleton', (uri?: vscode.Uri) => run('check', uri)),
    vscode.commands.registerCommand('afd.runReal', (uri?: vscode.Uri) => run('real', uri)),
    vscode.commands.registerCommand('afd.syntaxCheck', async (uri?: vscode.Uri) => {
      const doc = await host.resolveTargetFlow(uri);
      if (!doc) return;
      const outcome = await syntaxCheck(doc, host.deps.schema, host.probes, host.codeDiagnostics);
      if (outcome.ok) void vscode.window.showInformationMessage(outcome.message);
      else void vscode.window.showErrorMessage(outcome.message);
    }),
    vscode.commands.registerCommand('afd.showAudit', async () => {
      try {
        await vscode.window.showTextDocument(auditUri(host.storage), { preview: false });
      } catch {
        void vscode.window.showInformationMessage('No run has been launched yet.');
      }
    }),
    vscode.commands.registerCommand('afd.catalog.rebuild', async (uri?: vscode.Uri) => {
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
    vscode.commands.registerCommand('afd.awx.launch', async (uri?: vscode.Uri) => {
      const doc = await host.resolveTargetFlow(uri);
      if (!doc) return undefined;
      const result = await launchInAwx(doc, host.awxDeps(doc.uri));
      if (result.state === 'error')
        await showOutcomeError(result.error ?? 'The AWX run failed', result.errorCode, doc.uri);
      else if (result.state === 'done') void announceRun(result);
      return result;
    }),
    vscode.commands.registerCommand('afd.awx.setupTemplate', async (uri?: vscode.Uri) => {
      const doc = await host.resolveTargetFlow(uri);
      if (!doc) return;
      const r = await setupTemplate(doc, host.awxDeps(doc.uri));
      if (r.ok)
        void vscode.window.showInformationMessage(
          `AWX job template "${r.template}" is ready; the flow now launches it.`,
        );
      else if (!isCancelled(r.error))
        void vscode.window.showErrorMessage(r.error ?? 'Setting up the AWX template failed');
    }),
    vscode.commands.registerCommand('afd.awx.setToken', async (uri?: vscode.Uri) => {
      const scope = host.scopeUri(uri);
      if (!scope) return;
      const error = await setToken(scope, host.context.secrets);
      if (error && !isCancelled(error)) void vscode.window.showErrorMessage(error);
    }),
    vscode.commands.registerCommand('afd.awx.clearToken', async (uri?: vscode.Uri) => {
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

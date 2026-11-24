// Import commands (AFD-37): AWX workflows and job templates, playbooks and folders.
import * as vscode from 'vscode';
import { importAwxWorkflow } from '../awx/awxImport';
import { isCancelled } from '../errors';
import { type Host, VIEW_TYPE } from '../host';
import { announceImport } from '../import/common';
import { importPlaybooks } from '../import/playbookImport';
import { type ReimportRequest, reimportFromSource } from '../import/reimport';
import { CMD } from './ids';

/**
 * AFD-380: opens a flow the import has just written. A tab of that path kept from before the file
 * existed (restored from an earlier session, its file gone) shows "the file was not found" and is
 * only revealed by openWith, so it is closed first.
 */
async function openImported(uri: vscode.Uri): Promise<void> {
  const stale = vscode.window.tabGroups.all
    .flatMap((g) => g.tabs)
    .filter((t) => {
      const input = t.input;
      const at =
        input instanceof vscode.TabInputCustom || input instanceof vscode.TabInputText
          ? input.uri
          : undefined;
      return !t.isDirty && at?.toString() === uri.toString();
    });
  if (stale.length) await vscode.window.tabGroups.close(stale).then(undefined, () => undefined);
  await vscode.commands.executeCommand('vscode.openWith', uri, VIEW_TYPE);
}

export function registerImportCommands(host: Host): vscode.Disposable[] {
  return [
    vscode.commands.registerCommand(CMD.importAwx, async () => {
      const outcome = await importAwxWorkflow(host.context.secrets, host.deps.newId);
      // With an AI assistant, the prompt went to the chat or the clipboard (AFD-27).
      if (outcome.prompt) return;
      if (outcome.error) {
        if (!isCancelled(outcome.error)) void vscode.window.showErrorMessage(outcome.error);
        return;
      }
      if (outcome.uri) await openImported(outcome.uri);
      void announceImport({ ...outcome, uris: outcome.uri ? [outcome.uri] : [] });
    }),
    vscode.commands.registerCommand(CMD.importPlaybooks, async (uri?: vscode.Uri) => {
      const outcome = await importPlaybooks(host.playbookDeps, uri ? { source: uri } : {});
      // With an AI assistant, the prompt went to the chat or the clipboard (AFD-27).
      if (outcome.prompt) return;
      if (outcome.error && !outcome.uris.length) {
        if (!isCancelled(outcome.error)) void vscode.window.showErrorMessage(outcome.error);
        return;
      }
      if (outcome.uris[0]) await openImported(outcome.uris[0]);
      if (outcome.error) void vscode.window.showWarningMessage(outcome.error);
      void announceImport(outcome);
    }),
    vscode.commands.registerCommand(CMD.reimport, (uri?: vscode.Uri, request?: ReimportRequest) =>
      reimportFromSource(host, uri, request),
    ),
  ];
}

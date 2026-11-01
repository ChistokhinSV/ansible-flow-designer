// Import commands (AFD-37): AWX workflows and job templates, playbooks and folders.
import * as vscode from 'vscode';
import { importAwxWorkflow } from '../awx/awxImport';
import { isCancelled } from '../errors';
import { type Host, VIEW_TYPE } from '../host';
import { announceImport } from '../import/common';
import { importPlaybooks } from '../import/playbookImport';
import { type ReimportRequest, reimportFromSource } from '../import/reimport';
import { CMD } from './ids';

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
      if (outcome.uri)
        await vscode.commands.executeCommand('vscode.openWith', outcome.uri, VIEW_TYPE);
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
      if (outcome.uris[0])
        await vscode.commands.executeCommand('vscode.openWith', outcome.uris[0], VIEW_TYPE);
      if (outcome.error) void vscode.window.showWarningMessage(outcome.error);
      void announceImport(outcome);
    }),
    vscode.commands.registerCommand(CMD.reimport, (uri?: vscode.Uri, request?: ReimportRequest) =>
      reimportFromSource(host, uri, request),
    ),
  ];
}

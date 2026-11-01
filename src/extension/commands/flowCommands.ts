// Commands on a flow (AFD-37): Generate Code, New Flow, Tidy Up, Complete IDs, Copy and Paste
// Nodes, Open in Text Editor (Check Flow is with the run commands, AFD-41). Each works on the flow the user means (Host.resolveTargetFlow).
import * as vscode from 'vscode';
import { slugify } from '../../core/flow/ids';
import { newFlowText } from '../../core/flow/template';
import { COMPLETE_IDS, CompleteIdsActions } from '../ai/completeIdsAction';
import { writeCode } from '../documents';
import type { Host } from '../host';
import { CMD } from './ids';

export function registerFlowCommands(host: Host): vscode.Disposable[] {
  return [
    vscode.commands.registerCommand(CMD.generateCode, async (uri?: vscode.Uri) => {
      const doc = await host.resolveTargetFlow(uri);
      if (!doc) return;
      if (doc.isDirty) await doc.save();
      await writeCode(doc, host.deps, true);
    }),
    vscode.commands.registerCommand(CMD.newFlow, () => newFlow(host)),
    vscode.commands.registerCommand(CMD.tidyUp, async () => {
      const outcome = await host.activeSession()?.tidyUp();
      if (outcome && !outcome.ok)
        void vscode.window.showErrorMessage(outcome.error ?? 'Tidy Up failed');
    }),
    vscode.commands.registerCommand(COMPLETE_IDS, async (uri?: vscode.Uri) => {
      const doc = await host.resolveTargetFlow(uri);
      if (!doc) return;
      const outcome = await host.sessionFor(doc).completeIds();
      if (!outcome.ok) void vscode.window.showErrorMessage(outcome.error ?? 'IDs not completed');
    }),
    vscode.languages.registerCodeActionsProvider(
      { pattern: '**/*.flow.yaml' },
      new CompleteIdsActions(),
      { providedCodeActionKinds: CompleteIdsActions.kinds },
    ),
    vscode.commands.registerCommand(CMD.copyNodes, () => host.activeSession()?.copyNodes()),
    vscode.commands.registerCommand(CMD.pasteNodes, () => host.activeSession()?.pasteNodes()),
    vscode.commands.registerCommand(CMD.openInTextEditor, async (uri?: vscode.Uri) => {
      const target = host.targetUri(uri);
      if (target) await vscode.commands.executeCommand('vscode.openWith', target, 'default');
    }),
  ];
}

async function newFlow(host: Host): Promise<void> {
  const folders = vscode.workspace.workspaceFolders ?? [];
  const folder =
    folders.length > 1
      ? await vscode.window.showWorkspaceFolderPick({ placeHolder: 'Repository for the new flow' })
      : folders[0];
  if (!folder) {
    void vscode.window.showErrorMessage('Open a folder (the automation repository) first.');
    return;
  }
  const name = await vscode.window.showInputBox({
    title: 'New flow',
    prompt: 'Flow name',
    placeHolder: 'Edge baseline',
    validateInput: (v) => (v.trim() ? undefined : 'Enter a name'),
  });
  if (!name) return;
  const key = slugify(name, 'flow');
  const uri = vscode.Uri.joinPath(folder.uri, 'flows', key, `${key}.flow.yaml`);
  try {
    await vscode.workspace.fs.stat(uri);
    void vscode.window.showErrorMessage(`${vscode.workspace.asRelativePath(uri)} already exists.`);
    return;
  } catch {
    // Does not exist yet: create it.
  }
  await vscode.workspace.fs.writeFile(
    uri,
    new TextEncoder().encode(newFlowText(name.trim(), key, host.deps.newId)),
  );
  await host.openDesigner(uri);
}

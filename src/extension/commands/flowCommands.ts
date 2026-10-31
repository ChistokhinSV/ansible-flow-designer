// Commands on a flow (AFD-37): generate, new flow, tidy up, Complete IDs, copy and paste,
// validate, open as text. Each works on the flow the user means (Host.resolveTargetFlow).
import * as vscode from 'vscode';
import { slugify } from '../../core/flow/ids';
import { newFlowText } from '../../core/flow/template';
import { COMPLETE_IDS, CompleteIdsActions } from '../ai/completeIdsAction';
import { writeCode } from '../documents';
import type { Host } from '../host';

export function registerFlowCommands(host: Host): vscode.Disposable[] {
  return [
    vscode.commands.registerCommand('afd.generate', async (uri?: vscode.Uri) => {
      const doc = await host.resolveTargetFlow(uri);
      if (!doc) return;
      if (doc.isDirty) await doc.save();
      await writeCode(doc, host.deps, true);
    }),
    vscode.commands.registerCommand('afd.newFlow', () => newFlow(host)),
    vscode.commands.registerCommand('afd.tidyUp', async () => {
      const outcome = await host.activeSession()?.tidyUp();
      if (outcome && !outcome.ok)
        void vscode.window.showErrorMessage(outcome.error ?? 'Tidy up failed');
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
    vscode.commands.registerCommand('afd.copyNodes', () => host.activeSession()?.copyNodes()),
    vscode.commands.registerCommand('afd.pasteNodes', () => host.activeSession()?.pasteNodes()),
    vscode.commands.registerCommand('afd.validate', async () => {
      await host.activeSession()?.refresh();
      await vscode.commands.executeCommand('workbench.actions.view.problems');
    }),
    vscode.commands.registerCommand('afd.openAsText', async (uri?: vscode.Uri) => {
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

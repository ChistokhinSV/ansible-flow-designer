// The Ansible Flows view (AFD-73, ADR-0030): the workspace's flows in the Activity Bar, so a
// newcomer finds a way in without the Welcome page. With no folder or no flows it shows what to do
// (welcome content in package.json).
import * as vscode from 'vscode';
import { VIEW_TYPE } from './host';

const FLOWS = '**/*.flow.yaml';

export function registerFlowsView(): vscode.Disposable[] {
  const changed = new vscode.EventEmitter<void>();
  const provider: vscode.TreeDataProvider<vscode.Uri> = {
    onDidChangeTreeData: changed.event,
    getTreeItem(uri) {
      const name =
        uri.path
          .split('/')
          .pop()
          ?.replace(/\.flow\.yaml$/, '') ?? uri.path;
      const item = new vscode.TreeItem(name);
      item.resourceUri = uri;
      item.description = vscode.workspace.asRelativePath(
        uri.with({ path: uri.path.replace(/\/[^/]*$/, '') }),
      );
      item.iconPath = new vscode.ThemeIcon('type-hierarchy');
      item.contextValue = 'flow';
      item.command = { command: 'vscode.openWith', title: 'Open', arguments: [uri, VIEW_TYPE] };
      return item;
    },
    async getChildren(parent) {
      if (parent || !vscode.workspace.workspaceFolders?.length) return [];
      const found = await vscode.workspace.findFiles(FLOWS, '**/node_modules/**');
      return found.sort((a, b) => a.path.localeCompare(b.path));
    },
  };
  const watcher = vscode.workspace.createFileSystemWatcher(FLOWS, false, true, false);
  return [
    changed,
    watcher,
    vscode.window.createTreeView('afd.flows', { treeDataProvider: provider }),
    watcher.onDidCreate(() => changed.fire()),
    watcher.onDidDelete(() => changed.fire()),
    vscode.workspace.onDidChangeWorkspaceFolders(() => changed.fire()),
    vscode.commands.registerCommand('afd.flows.refresh', () => changed.fire()),
  ];
}

// The Ansible Flows view (AFD-73, ADR-0030): the workspace's flows in the Activity Bar, so a
// newcomer finds a way in without the Welcome page. With no folder or no flows it shows what to do
// (welcome content in package.json). AFD-86 (wave 8 group D): by folder, and each flow says its
// problems and whether its code is out of date or edited by hand (core/view/flowFacts.ts), read
// lazily and kept until the flow or its generated folder changes; Run as Skeleton and Peek Code
// on each. Round 1's participant gave up getting a repository's overview (P16). AFD-93: the facts
// come from the workspace index (flowIndex.ts), shared with Problems; a root per workspace folder.
import * as vscode from 'vscode';
import {
  CODE_MEANING,
  type FlowFacts,
  type FlowFolder,
  factsLine,
  flowTree,
} from '../core/view/flowFacts';
import { generatedDir } from './codegen';
import type { Host } from './host';
import { VIEW_TYPE } from './host';

type Item =
  | { kind: 'root'; folder: vscode.WorkspaceFolder }
  | { kind: 'folder'; folder: FlowFolder; base: vscode.Uri }
  | { kind: 'flow'; uri: vscode.Uri };

export function registerFlowsView(host: Host): vscode.Disposable[] {
  const changed = new vscode.EventEmitter<void>();
  // AFD-93: the workspace index reads and keeps the facts; the view only shows them.
  const factsOf = (uri: vscode.Uri) => host.index.facts(uri);
  /** The flows of one workspace folder, by their folders. */
  const treeOf = async (folder: vscode.WorkspaceFolder): Promise<Item[]> => {
    const rel = (await host.index.list())
      .filter((f) => f.folder.uri.toString() === folder.uri.toString())
      .map((f) => f.rel);
    const tree = flowTree(rel);
    const base = folder.uri;
    return [
      ...tree.folders.map((f): Item => ({ kind: 'folder', folder: f, base })),
      ...tree.flows.map((p): Item => ({ kind: 'flow', uri: vscode.Uri.joinPath(base, p) })),
    ];
  };
  const provider: vscode.TreeDataProvider<Item> = {
    onDidChangeTreeData: changed.event,
    async getTreeItem(item) {
      if (item.kind === 'root') {
        const t = new vscode.TreeItem(item.folder.name, vscode.TreeItemCollapsibleState.Expanded);
        t.iconPath = new vscode.ThemeIcon('root-folder');
        t.contextValue = 'afd-flow-root';
        return t;
      }
      if (item.kind === 'folder') {
        const t = new vscode.TreeItem(item.folder.name, vscode.TreeItemCollapsibleState.Expanded);
        t.iconPath = vscode.ThemeIcon.Folder;
        t.contextValue = 'afd-flow-folder';
        return t;
      }
      const uri = item.uri;
      const fallback =
        uri.path
          .split('/')
          .pop()
          ?.replace(/\.flow\.yaml$/, '') ?? uri.path;
      let f: FlowFacts | undefined;
      try {
        f = await factsOf(uri);
      } catch {}
      const t = new vscode.TreeItem(f?.name || fallback);
      t.resourceUri = uri;
      t.description = f ? factsLine(f) : '';
      const tip = new vscode.MarkdownString();
      tip.appendMarkdown(
        `**${f?.name || fallback}** · \`${vscode.workspace.asRelativePath(uri)}\`\n\n`,
      );
      if (f?.broken) tip.appendMarkdown(`The file does not parse: ${f.broken}\n\n`);
      else if (f) {
        tip.appendMarkdown(
          `${f.errors} error(s), ${f.warnings} warning(s) (open it for the Problems panel).\n\n`,
        );
        tip.appendMarkdown(`**Code:** ${CODE_MEANING[f.code]}`);
        if (f.kept.length) tip.appendMarkdown(` Edited by hand: ${f.kept.join(', ')}.`);
      }
      t.tooltip = tip;
      t.iconPath = new vscode.ThemeIcon(
        f?.broken || f?.errors
          ? 'error'
          : f?.code === 'edited by hand'
            ? 'edit'
            : f?.code === 'out of date'
              ? 'sync'
              : f?.warnings
                ? 'warning'
                : 'type-hierarchy',
      );
      t.contextValue = 'flow';
      t.command = { command: 'vscode.openWith', title: 'Open', arguments: [uri, VIEW_TYPE] };
      return t;
    },
    async getChildren(parent) {
      if (parent?.kind === 'flow') return [];
      if (parent?.kind === 'root') return treeOf(parent.folder);
      if (parent?.kind === 'folder')
        return [
          ...parent.folder.folders.map(
            (f): Item => ({ kind: 'folder', folder: f, base: parent.base }),
          ),
          ...parent.folder.flows.map(
            (p): Item => ({ kind: 'flow', uri: vscode.Uri.joinPath(parent.base, p) }),
          ),
        ];
      const folders = vscode.workspace.workspaceFolders ?? [];
      // One folder: its flows at the top, as before; several: a root per folder (AFD-93).
      if (folders.length === 1 && folders[0]) return treeOf(folders[0]);
      return folders.map((folder): Item => ({ kind: 'root', folder }));
    },
  };
  const openOn = async (uri: vscode.Uri) => {
    if (!host.sessions.get(uri.toString())?.hasPanels) await host.openDesigner(uri);
  };
  return [
    changed,
    vscode.window.createTreeView('afd.flows', { treeDataProvider: provider }),
    // The index watches the flows and their code, and says once per burst.
    host.index.onDidChange(() => changed.fire()),
    vscode.commands.registerCommand('afd.flows.refresh', () => {
      host.index.clear();
      changed.fire();
      void host.index.warm();
    }),
    vscode.commands.registerCommand('afd.flows.run', async (item?: Item) => {
      if (item?.kind !== 'flow') return;
      await openOn(item.uri);
      await host.sessions.get(item.uri.toString())?.openLaunch('check');
    }),
    vscode.commands.registerCommand('afd.flows.peekCode', async (item?: Item) => {
      if (item?.kind !== 'flow') return;
      const f = await factsOf(item.uri);
      const file = vscode.Uri.joinPath(generatedDir(item.uri), `${f.key}.yml`);
      try {
        await vscode.workspace.fs.stat(file);
        await vscode.window.showTextDocument(file, { preview: true });
      } catch {
        void vscode.window.showInformationMessage(
          `${f.name} has no generated code yet: open it and save, or run Generate Code.`,
        );
      }
    }),
  ];
}

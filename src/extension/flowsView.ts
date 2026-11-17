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
import { SERVER_STATE_WORDS } from '../core/view/serverFlows';
import { generatedDir } from './codegen';
import type { Host } from './host';
import { VIEW_TYPE } from './host';
import { attachFlowsPane } from './runner/connect';
import { nestedNote, registerNestedFolders } from './runner/nestedFolders';
import { ServerFlowsState } from './runner/serverFlows';

type Item =
  | { kind: 'root'; folder: vscode.WorkspaceFolder }
  | { kind: 'folder'; folder: FlowFolder; base: vscode.Uri }
  | { kind: 'flow'; uri: vscode.Uri }
  // AFD-303: the server project's flows this folder does not have.
  | { kind: 'server'; folder: vscode.WorkspaceFolder }
  | { kind: 'serverFlow'; folder: vscode.WorkspaceFolder; path: string };

/** AFD-303: the Flows pane's server state (the test API). */
let current: ServerFlowsState | undefined;
export const flowsServerState = () => current;

export function registerFlowsView(host: Host): vscode.Disposable[] {
  const changed = new vscode.EventEmitter<void>();
  // AFD-93: the workspace index reads and keeps the facts; the view only shows them.
  const factsOf = (uri: vscode.Uri) => host.index.facts(uri);
  // AFD-303: which flows are the connected server project's.
  const server = new ServerFlowsState(host.context.secrets, async (folder) =>
    (await host.index.list())
      .filter((f) => f.folder.uri.toString() === folder.uri.toString())
      .map((f) => f.rel),
  );
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
      ...(server.folder(folder)?.flows.missing.length ? [{ kind: 'server', folder } as Item] : []),
    ];
  };
  const provider: vscode.TreeDataProvider<Item> = {
    onDidChangeTreeData: changed.event,
    async getTreeItem(item) {
      if (item.kind === 'server') {
        const n = server.folder(item.folder)?.flows.missing.length ?? 0;
        const t = new vscode.TreeItem(
          'On the server, not here',
          vscode.TreeItemCollapsibleState.Collapsed,
        );
        t.description = `${n}`;
        t.iconPath = new vscode.ThemeIcon('cloud');
        t.tooltip = `${n} flow(s) of ${server.folder(item.folder)?.project ?? 'the project'} that this folder does not have.`;
        t.contextValue = 'afd-server-missing';
        return t;
      }
      if (item.kind === 'serverFlow') {
        const name = item.path.split('/').pop() ?? item.path;
        const t = new vscode.TreeItem(name.replace(/\.flow\.yaml$/, ''));
        t.description = item.path.includes('/') ? item.path.slice(0, -name.length - 1) : '';
        t.iconPath = new vscode.ThemeIcon('cloud');
        t.tooltip = server.folder(item.folder)?.repo
          ? `${item.path}: on the server only. Pull (Source Control) to get it here.`
          : `${item.path}: on the server only. Get the Project's Flows into an empty folder to have it here.`;
        t.contextValue = 'afd-server-flow';
        return t;
      }
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
      const onServer = server.stateOf(uri);
      if (onServer)
        t.description = [t.description, SERVER_STATE_WORDS[onServer].short]
          .filter(Boolean)
          .join(' · ');
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
      if (onServer) tip.appendMarkdown(`\n\n**Server:** ${SERVER_STATE_WORDS[onServer].long}`);
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
      if (parent?.kind === 'flow' || parent?.kind === 'serverFlow') return [];
      if (parent?.kind === 'server')
        return (server.folder(parent.folder)?.flows.missing ?? []).map(
          (path): Item => ({ kind: 'serverFlow', folder: parent.folder, path }),
        );
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
  const view = vscode.window.createTreeView('afd.flows', { treeDataProvider: provider });
  // AFD-301: the pane says which Ansible Flow Server the folder is connected to.
  attachFlowsPane(view as vscode.TreeView<unknown>);
  current = server;
  // AFD-303: what the server has that this folder does not, above the flows. AFD-323: and
  // repositories of flows inside a folder that is not one.
  let nested: string | undefined;
  const render = () => {
    const behind = (vscode.workspace.workspaceFolders ?? []).some((f) => server.folder(f)?.behind);
    view.message =
      [
        behind ? 'The server has newer commits of this project: pull to get them.' : '',
        nested ?? '',
      ]
        .filter(Boolean)
        .join(' ') || undefined;
  };
  const readNested = () => {
    nested = nestedNote();
    void vscode.commands.executeCommand('setContext', 'afd.hasNested', !!nested);
    render();
  };
  readNested();
  server.onDidChange(() => {
    render();
    changed.fire();
  });
  const reread = () => server.soon();
  setTimeout(reread, 0);
  return [
    changed,
    view,
    server,
    ...registerNestedFolders(host.context, readNested),
    host.index.onDidChange(reread),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('afd.runner')) reread();
    }),
    host.context.secrets.onDidChange((e) => {
      if (e.key.startsWith('afd.runner.token:')) reread();
    }),
    vscode.window.onDidChangeWindowState((w) => {
      if (w.focused) reread();
    }),
    // The index watches the flows and their code, and says once per burst.
    host.index.onDidChange(() => changed.fire()),
    vscode.commands.registerCommand('afd.flows.refresh', () => {
      host.index.clear();
      changed.fire();
      reread();
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

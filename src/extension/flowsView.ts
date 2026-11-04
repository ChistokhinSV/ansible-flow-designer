// The Ansible Flows view (AFD-73, ADR-0030): the workspace's flows in the Activity Bar, so a
// newcomer finds a way in without the Welcome page. With no folder or no flows it shows what to do
// (welcome content in package.json). AFD-86 (wave 8 group D): by folder, and each flow says its
// problems and whether its code is out of date or edited by hand (core/view/flowFacts.ts), read
// lazily and kept until the flow or its generated folder changes; Run as Skeleton and Peek Code
// on each. Round 1's participant gave up getting a repository's overview (P16).
import * as vscode from 'vscode';
import {
  CODE_MEANING,
  type FlowFacts,
  type FlowFolder,
  factsLine,
  flowFacts,
  flowTree,
} from '../core/view/flowFacts';
import { generatedDir, rootFromGenerated } from './codegen';
import type { Host } from './host';
import { VIEW_TYPE } from './host';

const FLOWS = '**/*.flow.yaml';

type Item =
  | { kind: 'folder'; folder: FlowFolder; base: vscode.Uri }
  | { kind: 'flow'; uri: vscode.Uri };

async function stampOf(uri: vscode.Uri): Promise<string> {
  const stat = async (u: vscode.Uri) => {
    try {
      return (await vscode.workspace.fs.stat(u)).mtime;
    } catch {
      return 0;
    }
  };
  const dir = generatedDir(uri);
  let generated = 0;
  try {
    for (const [name] of await vscode.workspace.fs.readDirectory(dir))
      generated = Math.max(generated, await stat(vscode.Uri.joinPath(dir, name)));
  } catch {}
  return `${await stat(uri)}:${generated}`;
}

async function readFacts(uri: vscode.Uri, host: Host): Promise<FlowFacts> {
  const dir = generatedDir(uri);
  const read = async (u: vscode.Uri) => {
    try {
      return new TextDecoder().decode(await vscode.workspace.fs.readFile(u));
    } catch {
      return undefined;
    }
  };
  // An open flow answers from its editor's text, as the Problems panel does.
  const open = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
  const text = open?.getText() ?? (await read(uri)) ?? '';
  return flowFacts(
    text,
    host.deps.schema,
    {
      read: (name) => read(vscode.Uri.joinPath(dir, name)),
      list: async () => {
        try {
          return (await vscode.workspace.fs.readDirectory(dir))
            .filter(([, type]) => type === vscode.FileType.File)
            .map(([name]) => name);
        } catch {
          return [];
        }
      },
    },
    { source: uri.path.split('/').pop() ?? 'flow.yaml', root: rootFromGenerated(uri) },
  );
}

export function registerFlowsView(host: Host): vscode.Disposable[] {
  const changed = new vscode.EventEmitter<void>();
  const facts = new Map<string, { stamp: string; facts: FlowFacts }>();
  const factsOf = async (uri: vscode.Uri) => {
    const stamp = await stampOf(uri);
    const known = facts.get(uri.toString());
    if (known?.stamp === stamp) return known.facts;
    const f = await readFacts(uri, host);
    facts.set(uri.toString(), { stamp, facts: f });
    return f;
  };
  const provider: vscode.TreeDataProvider<Item> = {
    onDidChangeTreeData: changed.event,
    async getTreeItem(item) {
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
      const folder = vscode.workspace.workspaceFolders?.[0];
      if (!folder) return [];
      if (parent?.kind === 'folder')
        return [
          ...parent.folder.folders.map(
            (f): Item => ({ kind: 'folder', folder: f, base: parent.base }),
          ),
          ...parent.folder.flows.map(
            (p): Item => ({ kind: 'flow', uri: vscode.Uri.joinPath(parent.base, p) }),
          ),
        ];
      // `undefined` keeps files.exclude (a pattern here would replace it); node_modules is skipped.
      const found = (await vscode.workspace.findFiles(FLOWS)).filter(
        (u) => !u.path.includes('/node_modules/'),
      );
      const base = folder.uri;
      const rel = found.map((u) => vscode.workspace.asRelativePath(u, false).replaceAll('\\', '/'));
      const tree = flowTree(rel);
      return [
        ...tree.folders.map((f): Item => ({ kind: 'folder', folder: f, base })),
        ...tree.flows.map((p): Item => ({ kind: 'flow', uri: vscode.Uri.joinPath(base, p) })),
      ];
    },
  };
  // Changes come in bursts (a save writes the flow and its playbooks): one refresh per burst.
  let timer: NodeJS.Timeout | undefined;
  const soon = () => {
    clearTimeout(timer);
    timer = setTimeout(() => changed.fire(), 300);
  };
  const flowsWatcher = vscode.workspace.createFileSystemWatcher(FLOWS);
  const codeWatcher = vscode.workspace.createFileSystemWatcher('**/generated/*.yml');
  const openOn = async (uri: vscode.Uri) => {
    if (!host.sessions.get(uri.toString())?.hasPanels) await host.openDesigner(uri);
  };
  return [
    changed,
    flowsWatcher,
    codeWatcher,
    vscode.window.createTreeView('afd.flows', { treeDataProvider: provider }),
    flowsWatcher.onDidCreate(soon),
    flowsWatcher.onDidDelete(soon),
    flowsWatcher.onDidChange(soon),
    codeWatcher.onDidCreate(soon),
    codeWatcher.onDidDelete(soon),
    codeWatcher.onDidChange(soon),
    // An open flow answers from its editor: its facts change as it is edited.
    vscode.workspace.onDidSaveTextDocument((d) => d.uri.path.endsWith('.flow.yaml') && soon()),
    vscode.workspace.onDidChangeWorkspaceFolders(soon),
    vscode.commands.registerCommand('afd.flows.refresh', () => {
      facts.clear();
      changed.fire();
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

// AFD-320: History. The Ansible Flows sidebar's History view lists the folder's commits (who, when,
// the message, the files each changed), with a filter and more commits on request; a file opens as
// that commit left it (a flow in the designer's past version, any other file as VS Code's diff).
// A flow's own history (the designer's … menu, the Flows pane) is a quick pick of the commits that
// changed its flow or scenarios file.
import { dirname, posix, relative, sep } from 'node:path';
import * as vscode from 'vscode';
import {
  type ChangedFile,
  type Commit,
  commitMatches,
  readLog,
  repositoryRoot,
} from '../../node/history/gitLog';
import { CMD } from '../commands/ids';
import { onHeadMoved } from '../gitHead';
import type { Host } from '../host';
import { openPast, openPastDiff, type PastRef } from './pastDocs';

/** Commits read per page; a filter reads up to FILTER_SCAN and shows the matches. */
const PAGE = 100;
const FILTER_SCAN = 2000;

type Item =
  | { kind: 'folder'; folder: vscode.WorkspaceFolder }
  | { kind: 'commit'; root: string; commit: Commit }
  | { kind: 'file'; root: string; commit: Commit; file: ChangedFile }
  | { kind: 'more'; folder: vscode.WorkspaceFolder }
  | { kind: 'note'; text: string };

interface FolderLog {
  root?: string;
  commits: Commit[];
  /** More commits may be there (the last page was full). */
  more: boolean;
  error?: string;
}

const STATUS: Record<string, string> = {
  A: 'added',
  M: 'changed',
  D: 'deleted',
  R: 'renamed',
  C: 'copied',
  T: 'type changed',
};

const isFlow = (path: string) => path.endsWith('.flow.yaml');
const day = (iso: string) => iso.slice(0, 10);

/** The commit and a file of it, as the past-version documents take them. */
export function pastRefOf(root: string, commit: Commit, path: string, from?: string): PastRef {
  return {
    root,
    hash: commit.hash,
    author: commit.author,
    date: commit.date,
    subject: commit.subject,
    path,
    ...(from ? { from } : {}),
    parent: commit.parents.length > 0,
  };
}

function tooltip(commit: Commit): vscode.MarkdownString {
  const md = new vscode.MarkdownString(undefined, true);
  md.appendMarkdown(
    `**${mdText(commit.subject)}**\n\n${mdText(commit.author)} · ${day(commit.date)} · \`${commit.hash.slice(0, 7)}\``,
  );
  if (commit.body) md.appendMarkdown(`\n\n${mdText(commit.body).replace(/\n/g, '  \n')}`);
  if (commit.files.length)
    md.appendMarkdown(
      `\n\n${commit.files
        .slice(0, 20)
        .map((f) => `- ${STATUS[f.status] ?? f.status}: \`${f.path}\``)
        .join('\n')}${commit.files.length > 20 ? `\n- and ${commit.files.length - 20} more` : ''}`,
    );
  return md;
}

const mdText = (text: string) => text.replace(/[\\`*_{}[\]()#+\-.!|<>]/g, '\\$&');

export class HistoryView implements vscode.TreeDataProvider<Item> {
  private readonly changed = new vscode.EventEmitter<Item | undefined>();
  readonly onDidChangeTreeData = this.changed.event;
  private readonly logs = new Map<string, FolderLog>();
  private filter = '';
  view?: vscode.TreeView<Item>;

  /** The view's filter: words matched in message, author, hash and file paths. */
  get filterText(): string {
    return this.filter;
  }

  setFilter(text: string): void {
    this.filter = text.trim();
    void vscode.commands.executeCommand('setContext', 'afd.historyFiltered', !!this.filter);
    if (this.view) this.view.description = this.filter ? `filter: ${this.filter}` : undefined;
    this.refresh();
  }

  refresh(): void {
    this.logs.clear();
    this.changed.fire(undefined);
  }

  /** The next page of the folder's commits. */
  async more(folder: vscode.WorkspaceFolder): Promise<void> {
    const log = this.logs.get(folder.uri.toString());
    if (!log?.root) return;
    const next = await readLog(log.root, { skip: log.commits.length, max: PAGE });
    log.commits.push(...next);
    log.more = next.length === PAGE;
    this.changed.fire(undefined);
  }

  /** The folder's commits as shown: a page, or the matches of the filter. */
  async logOf(folder: vscode.WorkspaceFolder): Promise<FolderLog> {
    const key = folder.uri.toString();
    const kept = this.logs.get(key);
    if (kept) return kept;
    const root = await repositoryRoot(folder.uri.fsPath);
    let log: FolderLog;
    if (!root) log = { commits: [], more: false };
    else
      try {
        if (this.filter) {
          const all = await readLog(root, { max: FILTER_SCAN });
          log = { root, commits: all.filter((c) => commitMatches(c, this.filter)), more: false };
        } else {
          const commits = await readLog(root, { max: PAGE });
          log = { root, commits, more: commits.length === PAGE };
        }
      } catch (e) {
        log = { root, commits: [], more: false, error: (e as Error).message };
      }
    this.logs.set(key, log);
    return log;
  }

  async getChildren(item?: Item): Promise<Item[]> {
    const folders = vscode.workspace.workspaceFolders ?? [];
    if (!item) {
      if (folders.length === 1 && folders[0]) return this.folderChildren(folders[0]);
      return folders.map((folder) => ({ kind: 'folder', folder }));
    }
    if (item.kind === 'folder') return this.folderChildren(item.folder);
    if (item.kind === 'commit')
      return item.commit.files.map((file) => ({
        kind: 'file',
        root: item.root,
        commit: item.commit,
        file,
      }));
    return [];
  }

  private async folderChildren(folder: vscode.WorkspaceFolder): Promise<Item[]> {
    const log = await this.logOf(folder);
    if (log.error) return [{ kind: 'note', text: `git: ${log.error}` }];
    if (!log.root) return [{ kind: 'note', text: 'This folder is not a git repository' }];
    if (!log.commits.length)
      return [
        {
          kind: 'note',
          text: this.filter ? `No commit matches "${this.filter}"` : 'No commits yet',
        },
      ];
    const root = log.root;
    const items: Item[] = log.commits.map((commit) => ({ kind: 'commit', root, commit }));
    if (log.more) items.push({ kind: 'more', folder });
    return items;
  }

  getTreeItem(item: Item): vscode.TreeItem {
    switch (item.kind) {
      case 'folder': {
        const t = new vscode.TreeItem(item.folder.name, vscode.TreeItemCollapsibleState.Expanded);
        t.iconPath = new vscode.ThemeIcon('root-folder');
        return t;
      }
      case 'note': {
        const t = new vscode.TreeItem(item.text);
        t.iconPath = new vscode.ThemeIcon('info');
        return t;
      }
      case 'more': {
        const t = new vscode.TreeItem(`Show ${PAGE} More…`);
        t.iconPath = new vscode.ThemeIcon('ellipsis');
        t.command = { command: CMD.historyMore, title: 'Show More', arguments: [item.folder] };
        return t;
      }
      case 'commit': {
        const c = item.commit;
        const flows = c.files.filter((f) => isFlow(f.path)).length;
        const t = new vscode.TreeItem(
          c.subject || '(no message)',
          c.files.length
            ? vscode.TreeItemCollapsibleState.Collapsed
            : vscode.TreeItemCollapsibleState.None,
        );
        t.id = `${item.root}#${c.hash}`;
        t.description = `${c.author} · ${day(c.date)}${flows ? ` · ${flows} flow${flows === 1 ? '' : 's'}` : ''}`;
        t.tooltip = tooltip(c);
        t.iconPath = new vscode.ThemeIcon(c.parents.length > 1 ? 'git-merge' : 'git-commit');
        t.contextValue = 'commit';
        return t;
      }
      case 'file': {
        const f = item.file;
        const t = new vscode.TreeItem(posix.basename(f.path));
        t.id = `${item.root}#${item.commit.hash}#${f.path}`;
        const dir = posix.dirname(f.path);
        t.description = `${STATUS[f.status] ?? f.status}${dir === '.' ? '' : ` · ${dir}`}`;
        t.tooltip = f.from ? `${f.from} → ${f.path}` : f.path;
        t.resourceUri = vscode.Uri.file(posix.join(item.root.replace(/\\/g, '/'), f.path));
        if (isFlow(f.path)) t.iconPath = new vscode.ThemeIcon('type-hierarchy-sub');
        t.contextValue = isFlow(f.path) ? 'historyFlow' : 'historyFile';
        t.command = {
          command: CMD.historyOpenFile,
          title: isFlow(f.path) ? 'Open the Flow as This Commit Left It' : 'Open the Change',
          arguments: [item],
        };
        return t;
      }
    }
  }
}

/** Opens a file of a commit: a flow (not deleted) in the designer, any other file as a diff. */
export async function openCommitFile(root: string, commit: Commit, file: ChangedFile) {
  const ref = pastRefOf(root, commit, file.path, file.from);
  if (isFlow(file.path) && file.status !== 'D') await openPast(ref);
  else await openPastDiff(ref, file.status);
}

export interface FlowHistoryPick extends vscode.QuickPickItem {
  commit: Commit;
  root: string;
  rel: string;
  flowFile?: ChangedFile;
}

/** The commits that changed a flow's flow or scenarios file, as quick pick items (or why none). */
export async function flowHistoryItems(uri: vscode.Uri): Promise<FlowHistoryPick[] | string> {
  if (uri.scheme !== 'file') return 'History is shown for a flow file in a folder';
  const root = await repositoryRoot(dirname(uri.fsPath));
  if (!root) return 'This flow is not in a git repository: it has no history';
  // The platform's relative(): on Windows it ignores the drive letter's case (c: and C:).
  const rel = relative(root, uri.fsPath).split(sep).join('/');
  const scenarios = rel.replace(/\.flow\.yaml$/, '.scenarios.yaml');
  const commits = await readLog(root, { paths: [rel, scenarios], max: 500 });
  if (!commits.length) return `${posix.basename(rel)} has no commits yet`;
  return commits.map((c): FlowHistoryPick => {
    const touched = c.files.filter((f) => f.path === rel || f.path === scenarios);
    return {
      label: c.subject || '(no message)',
      description: `${c.author} · ${day(c.date)}`,
      detail: `${c.hash.slice(0, 7)} · ${touched
        .map((f) => `${f.path === rel ? 'flow' : 'scenarios'} ${STATUS[f.status] ?? f.status}`)
        .join(', ')}`,
      commit: c,
      root,
      rel,
      flowFile: touched.find((f) => f.path === rel),
    };
  });
}

/** AFD-320: a flow's history: the commits that changed its flow or scenarios file; one opens. */
export async function showFlowHistory(uri: vscode.Uri): Promise<string | undefined> {
  const items = await flowHistoryItems(uri);
  if (typeof items === 'string') return items;
  const rel = items[0]?.rel ?? '';
  const pick = await vscode.window.showQuickPick(items, {
    title: `History of ${posix.basename(rel)}`,
    placeHolder: 'Filter by message, author or date; pick a commit to see what it changed',
    matchOnDescription: true,
    matchOnDetail: true,
  });
  if (!pick) return undefined;
  if (pick.flowFile?.status === 'D')
    await openPastDiff(pastRefOf(pick.root, pick.commit, rel), 'D');
  else await openPast(pastRefOf(pick.root, pick.commit, rel, pick.flowFile?.from));
  return undefined;
}

export function registerHistoryView(host: Host): vscode.Disposable[] {
  const provider = new HistoryView();
  const view = vscode.window.createTreeView('afd.history', {
    treeDataProvider: provider,
    showCollapseAll: true,
  });
  provider.view = view;
  const heads: vscode.Disposable[] = [];
  const watchHeads = async () => {
    for (const d of heads.splice(0)) d.dispose();
    for (const f of vscode.workspace.workspaceFolders ?? []) {
      const d = await onHeadMoved(f.uri, () => provider.refresh());
      if (d) heads.push(d);
    }
  };
  void watchHeads();
  return [
    view,
    {
      dispose: () => {
        for (const d of heads) d.dispose();
      },
    },
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      provider.refresh();
      void watchHeads();
    }),
    vscode.commands.registerCommand(CMD.historyRefresh, () => provider.refresh()),
    vscode.commands.registerCommand(CMD.historyFilter, async () => {
      const text = await vscode.window.showInputBox({
        title: 'Filter the history',
        prompt: 'Words in the message, the author, a commit hash or a file path (all must match)',
        value: provider.filterText,
      });
      if (text !== undefined) provider.setFilter(text);
    }),
    vscode.commands.registerCommand(CMD.historyClearFilter, () => provider.setFilter('')),
    vscode.commands.registerCommand(CMD.historyMore, (folder: vscode.WorkspaceFolder) =>
      provider.more(folder),
    ),
    vscode.commands.registerCommand(CMD.historyOpenFile, (item?: Item) =>
      item?.kind === 'file' ? openCommitFile(item.root, item.commit, item.file) : undefined,
    ),
    vscode.commands.registerCommand(CMD.historyCopyHash, (item?: Item) =>
      item?.kind === 'commit' ? vscode.env.clipboard.writeText(item.commit.hash) : undefined,
    ),
    vscode.commands.registerCommand(CMD.flowHistory, async (arg?: unknown) => {
      // From the Flows pane an item, from the designer or the palette a URI or nothing.
      const given =
        arg instanceof vscode.Uri
          ? arg
          : (arg as { uri?: unknown } | undefined)?.uri instanceof vscode.Uri
            ? (arg as { uri: vscode.Uri }).uri
            : undefined;
      const uri = host.targetUri(given);
      if (!uri) return void vscode.window.showInformationMessage('Open a flow first.');
      const error = await showFlowHistory(uri);
      if (error) void vscode.window.showInformationMessage(error);
    }),
  ];
}

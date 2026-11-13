// The Inventory view (AFD-83, wave 8 group I): the inventory the runs use, by group, read in the
// run environment (the probe's inventory_tree), so the groups and hosts show without opening the
// files, and a run can be pointed at one (Run Flow on This Group…: the designer's launch dialog
// with it as the targets). Round 1: P6, and the inventory was the participant's most confusing part
// and the one thing to change.
import * as vscode from 'vscode';
import { showValue } from '../core/inventory/edit';
import {
  isStatic,
  newInventoryText,
  type Origin,
  SOURCE_LABEL,
  type SourceKind,
  touchesInventory,
} from '../core/inventory/origins';
import { inventoryCandidates, inventoryPath } from '../core/view/inventorySources';
import { type InventoryTree as Tree, type TreeGroup, topGroups } from '../core/view/inventoryTree';
import { TIMEOUTS } from '../node/timeouts';
import { environmentFor } from './env/environment';
import type { Host } from './host';
import { VIEW_TYPE } from './host';
import { registerInventoryEdits } from './inventoryEdit';
import {
  type InventoryFiles,
  readInventoryFiles,
  type ShownVar,
  type SourceFile,
  targetVars,
} from './inventoryFiles';

export type InventoryItem =
  /** `parent`: the group it is shown under, for a move (absent at the top level). */
  | { kind: 'group'; group: TreeGroup; parent?: string }
  /** `group`: the group it is listed under, so it opens at its line there. */
  | { kind: 'host'; host: string; group?: string }
  /** AFD-258: the files the inventory is read from. */
  | { kind: 'sources' }
  | { kind: 'source'; source: SourceFile }
  /** AFD-260: a variable of a host or a group, where it is written. */
  | { kind: 'var'; variable: ShownVar; host?: string; group?: string }
  /** AFD-262: something Ansible will refuse in an inventory file; opens its line. */
  | { kind: 'problem'; file: string; line: number; message: string }
  | { kind: 'note'; text: string; command?: vscode.Command };

const sourceLabel = (kind: SourceFile['kind']): string =>
  kind === 'missing'
    ? 'not found'
    : kind === 'outside'
      ? 'outside the workspace folder (not read here)'
      : SOURCE_LABEL[kind as SourceKind];

export function registerInventoryView(host: Host): vscode.Disposable[] {
  const changed = new vscode.EventEmitter<InventoryItem | undefined>();
  let tree: Tree | undefined;
  let problem: string | undefined;
  /** AFD-258: the inventory's files and where its hosts and groups are written in them. */
  let files: InventoryFiles | undefined;
  const forget = () => {
    tree = undefined;
    problem = undefined;
    files = undefined;
    changed.fire(undefined);
  };
  const folder = () => {
    const flow = host.targetUri();
    return (
      (flow && vscode.workspace.getWorkspaceFolder(flow)?.uri) ??
      vscode.workspace.workspaceFolders?.[0]?.uri
    );
  };
  const setting = (at: vscode.Uri) =>
    inventoryPath(vscode.workspace.getConfiguration('afd', at).get<string>('run.inventory', ''));
  /** AFD-255/256: the title line says which inventory, in which environment. */
  const describe = (at: vscode.Uri | undefined) => {
    if (!at) return undefined;
    const env = environmentFor(at);
    const inventory = setting(at) || (tree ? tree.sources.join(', ') : 'default inventory');
    return env.ok ? `${inventory} · ${env.env.label}` : inventory;
  };
  /**
   * AFD-256: the inventories of the repository, the default of ansible.cfg and Browse…; the pick is
   * this workspace's `afd.run.inventory`. Resolves true when it changed.
   */
  const switchInventory = async (): Promise<boolean> => {
    const at = folder();
    if (!at) return false;
    const now = setting(at);
    const files = await vscode.workspace.findFiles(
      new vscode.RelativePattern(
        at,
        '{hosts,hosts.*,inventory,inventory.*,inventory/**,inventories/**}',
      ),
      undefined,
      2000,
    );
    const root = at.path.endsWith('/') ? at.path : `${at.path}/`;
    const found = inventoryCandidates(files.map((f) => f.path.slice(root.length)));
    // Set by hand to something the search does not find: still in the list, as the one in use.
    if (now && !found.includes(now)) found.unshift(now);
    type Pick = vscode.QuickPickItem & { value?: string; browse?: true };
    const icon = (current: boolean) => new vscode.ThemeIcon(current ? 'check' : 'blank');
    const items: Pick[] = [
      {
        label: 'The Default of ansible.cfg',
        detail: now ? undefined : tree?.sources.join(', '),
        description: now ? undefined : 'in use',
        iconPath: icon(!now),
        value: '',
      },
      ...found.map(
        (path): Pick => ({
          label: path,
          description: path === now ? 'in use' : undefined,
          iconPath: icon(path === now),
          value: path,
        }),
      ),
      { label: '', kind: vscode.QuickPickItemKind.Separator },
      { label: 'Browse…', iconPath: new vscode.ThemeIcon('folder-opened'), browse: true },
    ];
    const picked = await vscode.window.showQuickPick(items, {
      title: 'Switch Inventory',
      placeHolder: 'The inventory runs, the launch dialog and this view use',
    });
    if (!picked) return false;
    let value = picked.value;
    if (picked.browse) {
      const [chosen] =
        (await vscode.window.showOpenDialog({
          title: 'Switch Inventory',
          openLabel: 'Use This Inventory',
          defaultUri: at,
          canSelectFiles: true,
          canSelectFolders: true,
          canSelectMany: false,
        })) ?? [];
      if (!chosen) return false;
      if (!chosen.path.startsWith(root)) {
        void vscode.window.showErrorMessage(
          'The inventory has to be inside the workspace folder: runs read it from the repository.',
        );
        return false;
      }
      value = chosen.path.slice(root.length);
    }
    if (value === undefined || value === now) return false;
    await vscode.workspace
      .getConfiguration('afd', at)
      .update('run.inventory', value || undefined, vscode.ConfigurationTarget.Workspace);
    return true;
  };
  const load = async (at: vscode.Uri) => {
    files = await readInventoryFiles(at, setting(at)).catch(() => undefined);
    const probe = host.probes.forFolder(at);
    if ('error' in probe) {
      problem = probe.error;
      return;
    }
    const inventory =
      vscode.workspace.getConfiguration('afd', at).get<string>('run.inventory', '') || undefined;
    try {
      tree = await probe.client.call<Tree>(
        'inventory_tree',
        { inventory },
        TIMEOUTS.probeInventory,
      );
      problem = undefined;
    } catch (e) {
      problem = `The Ansible environment (${probe.label}) did not answer: ${(e as Error).message}`;
    }
  };
  const byName = (name: string) => tree?.groups.find((g) => g.name === name);
  const provider: vscode.TreeDataProvider<InventoryItem> = {
    onDidChangeTreeData: changed.event,
    getTreeItem(item) {
      if (item.kind === 'note') {
        const t = new vscode.TreeItem(item.text);
        t.iconPath = new vscode.ThemeIcon('info');
        if (item.command) t.command = item.command;
        return t;
      }
      if (item.kind === 'problem') {
        const t = new vscode.TreeItem(item.message);
        t.description = `${item.file}:${item.line + 1}`;
        t.tooltip = `${item.file}, line ${item.line + 1}: ${item.message}. Ansible leaves out what it cannot read: the group, or the whole file.`;
        t.iconPath = new vscode.ThemeIcon(
          'warning',
          new vscode.ThemeColor('problemsWarningIcon.foreground'),
        );
        t.command = { command: 'afd.inventory.open', title: 'Open in Editor', arguments: [item] };
        return t;
      }
      if (item.kind === 'sources') {
        const t = new vscode.TreeItem('Sources', vscode.TreeItemCollapsibleState.Collapsed);
        const n = files?.sources.length ?? 0;
        t.description = `${n} file${n === 1 ? '' : 's'}`;
        t.tooltip = 'The files this inventory is read from';
        t.iconPath = new vscode.ThemeIcon('files');
        return t;
      }
      if (item.kind === 'source') {
        const s = item.source;
        const t = new vscode.TreeItem(s.path);
        t.description = sourceLabel(s.kind);
        t.iconPath = new vscode.ThemeIcon(
          s.uri ? (isStatic(s.kind as SourceKind) ? 'file' : 'lock') : 'warning',
        );
        if (s.uri) {
          t.resourceUri = s.uri;
          t.contextValue = 'afd-source';
          t.command = { command: 'afd.inventory.open', title: 'Open in Editor', arguments: [item] };
        }
        return t;
      }
      if (item.kind === 'var') {
        const v = item.variable;
        const t = new vscode.TreeItem(v.key);
        const shown = showValue(v);
        t.description = shown.length > 80 ? `${shown.slice(0, 79)}…` : shown;
        t.tooltip = `${v.key}: ${v.file}, line ${v.line + 1}`;
        t.iconPath = new vscode.ThemeIcon(v.vaulted ? 'lock' : 'symbol-variable');
        t.contextValue = v.vaulted ? 'afd-var-vaulted' : 'afd-var';
        t.command = { command: 'afd.inventory.open', title: 'Open in Editor', arguments: [item] };
        return t;
      }
      if (item.kind === 'host') {
        const own = files ? targetVars(files, { host: item.host }) : [];
        const vars = own.length;
        const t = new vscode.TreeItem(
          item.host,
          vars ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None,
        );
        // AFD-262: the address first, where one looks for it; then how many other variables.
        const address = own.find((v) => v.key === 'ansible_host' && !v.vaulted);
        const others = vars - (address ? 1 : 0);
        t.description = [
          address ? showValue(address) : '',
          others ? `${others} variable${others === 1 ? '' : 's'}` : '',
        ]
          .filter(Boolean)
          .join(' · ');
        t.iconPath = new vscode.ThemeIcon('vm');
        t.contextValue = 'afd-host';
        const origin = files?.index.host(item.host, item.group);
        if (origin) {
          t.tooltip = `${item.host}: ${origin.file}, line ${origin.line + 1}${origin.range ? ` (one of ${origin.range})` : ''}`;
          t.command = { command: 'afd.inventory.open', title: 'Open in Editor', arguments: [item] };
        } else
          t.tooltip = `${item.host}: not written in a file of this inventory (a dynamic source)`;
        return t;
      }
      const g = item.group;
      const groupVars = files ? targetVars(files, { group: g.name }).length : 0;
      const t = new vscode.TreeItem(
        g.name,
        g.hosts.length + g.children.length + groupVars > 0
          ? vscode.TreeItemCollapsibleState.Collapsed
          : vscode.TreeItemCollapsibleState.None,
      );
      t.description = `${g.count} host${g.count === 1 ? '' : 's'}${groupVars ? `, ${groupVars} variable${groupVars === 1 ? '' : 's'}` : ''}`;
      t.tooltip = `${g.name}: ${g.count} host${g.count === 1 ? '' : 's'}${g.children.length ? `, groups ${g.children.join(', ')}` : ''}`;
      t.iconPath = new vscode.ThemeIcon('server-environment');
      t.contextValue = 'afd-group';
      return t;
    },
    async getChildren(parent) {
      if (parent?.kind === 'host')
        return files
          ? targetVars(files, { host: parent.host }).map(
              (variable): InventoryItem => ({ kind: 'var', variable, host: parent.host }),
            )
          : [];
      if (parent?.kind === 'group')
        return [
          ...(files
            ? targetVars(files, { group: parent.group.name }).map(
                (variable): InventoryItem => ({
                  kind: 'var',
                  variable,
                  group: parent.group.name,
                }),
              )
            : []),
          ...parent.group.children
            .map(byName)
            .filter((g): g is TreeGroup => !!g)
            .map((group): InventoryItem => ({ kind: 'group', group, parent: parent.group.name })),
          ...parent.group.hosts.map(
            (h): InventoryItem => ({ kind: 'host', host: h, group: parent.group.name }),
          ),
        ];
      if (parent?.kind === 'sources')
        return (files?.sources ?? []).map((source): InventoryItem => ({ kind: 'source', source }));
      if (parent) return [];
      const at = folder();
      if (!at) return [];
      if (!tree && !problem) await load(at);
      view.description = describe(at);
      if (problem)
        return [
          { kind: 'note', text: problem },
          {
            kind: 'note',
            text: 'Set Up Ansible Environment…',
            command: { command: 'afd.environment.setup', title: 'Set Up Ansible Environment…' },
          },
        ];
      const top = topGroups(tree as Tree);
      // What Ansible refuses comes first: it is why hosts are missing.
      const sources: InventoryItem[] = [
        ...(files?.problems ?? []).map((p): InventoryItem => ({ kind: 'problem', ...p })),
        ...(files?.sources.length ? [{ kind: 'sources' } as InventoryItem] : []),
      ];
      return top.length
        ? [...sources, ...top.map((group): InventoryItem => ({ kind: 'group', group }))]
        : [
            ...sources,
            {
              kind: 'note',
              text: files?.problems.length
                ? `No hosts: Ansible does not read ${[...new Set(files.problems.map((p) => p.file))].join(', ')} as it is written`
                : `No hosts in ${(tree as Tree).sources.join(', ')}`,
            },
            {
              kind: 'note',
              text: 'New Inventory…',
              command: { command: 'afd.inventory.new', title: 'New Inventory…' },
            },
          ];
    },
  };
  /** AFD-258: a host, a group or a source file in the editor, at the line it is written on. */
  const open = async (item?: InventoryItem) => {
    const at = folder();
    if (!at || !item) return;
    // Asked before the view was shown (a keybinding, a test): the files are read now.
    files ??= await readInventoryFiles(at, setting(at)).catch(() => undefined);
    let origin: Origin | undefined;
    let name = '';
    if (item.kind === 'source') {
      if (item.source.uri) await vscode.window.showTextDocument(item.source.uri);
      return;
    }
    if (item.kind === 'problem') {
      name = item.message;
      origin = { file: item.file, line: item.line };
    } else if (item.kind === 'var') {
      name = item.variable.key;
      origin = { file: item.variable.file, line: item.variable.line };
    } else if (item.kind === 'host') {
      name = item.host;
      origin = files?.index.host(item.host, item.group);
    } else if (item.kind === 'group') {
      name = item.group.name;
      origin = files?.index.group(name);
    } else return;
    if (!origin) {
      const dynamic = files?.sources.some((s) => s.kind === 'plugin' || s.kind === 'script');
      void vscode.window.showInformationMessage(
        dynamic
          ? `${name} is not written in a file of this inventory: it comes from a dynamic source.`
          : `${name} is not written in a file of this inventory (Ansible adds some groups itself, such as all and ungrouped).`,
      );
      return;
    }
    const position = new vscode.Position(origin.line, 0);
    await vscode.window.showTextDocument(vscode.Uri.joinPath(at, origin.file), {
      selection: new vscode.Range(position, position),
    });
    if (origin.range)
      vscode.window.setStatusBarMessage(`${name} is one of the range ${origin.range}`, 6000);
  };
  /** AFD-258: a YAML inventory to start from, set as this workspace's inventory and opened. */
  const create = async (): Promise<boolean> => {
    const at = folder();
    if (!at) return false;
    const exists = async (path: string) => {
      try {
        await vscode.workspace.fs.stat(vscode.Uri.joinPath(at, path));
        return true;
      } catch {
        return false;
      }
    };
    const given = await vscode.window.showInputBox({
      title: 'New Inventory',
      prompt:
        'Where to create it, in the repository. A YAML inventory with no hosts yet; it becomes the inventory of this workspace (afd.run.inventory).',
      value: (await exists('inventory/hosts.yml')) ? 'inventory/new.yml' : 'inventory/hosts.yml',
      ignoreFocusOut: true,
      validateInput: async (v) => {
        const path = inventoryPath(v);
        if (!/\.ya?ml$/i.test(path)) return 'A file name ending in .yml or .yaml';
        if (path.startsWith('/') || path.split('/').includes('..'))
          return 'A path inside the workspace folder';
        return (await exists(path)) ? `${path} is there already` : undefined;
      },
    });
    if (!given) return false;
    const path = inventoryPath(given);
    const uri = vscode.Uri.joinPath(at, path);
    // The box checked it; a file made in between is not overwritten.
    if (await exists(path)) return false;
    await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(newInventoryText()));
    await vscode.workspace
      .getConfiguration('afd', at)
      .update('run.inventory', path, vscode.ConfigurationTarget.Workspace);
    await vscode.window.showTextDocument(uri);
    return true;
  };
  /** A file of the inventory changed on disk: the view reads again. */
  const onFile = (uri: vscode.Uri) => {
    const at = folder();
    if (!at || (!tree && !problem)) return;
    const root = at.path.endsWith('/') ? at.path : `${at.path}/`;
    if (
      uri.path.startsWith(root) &&
      touchesInventory(
        uri.path.slice(root.length),
        files?.sources.map((s) => s.path),
      )
    )
      forget();
  };
  const runOn = async (item?: InventoryItem) => {
    const target =
      item?.kind === 'group' ? item.group.name : item?.kind === 'host' ? item.host : undefined;
    if (!target) return;
    const doc = await host.resolveTargetFlow();
    if (!doc) return;
    // The launch dialog lives in the designer: open it there first.
    if (!host.sessions.get(doc.uri.toString())?.hasPanels)
      await vscode.commands.executeCommand('vscode.openWith', doc.uri, VIEW_TYPE);
    await host.sessions
      .get(doc.uri.toString())
      ?.openLaunch('check', undefined, { targets: target });
  };
  const view = vscode.window.createTreeView('afd.inventory', { treeDataProvider: provider });
  view.description = describe(folder());
  return [
    changed,
    view,
    vscode.commands.registerCommand('afd.inventory.switch', switchInventory),
    vscode.commands.registerCommand('afd.inventory.refresh', forget),
    vscode.commands.registerCommand('afd.inventory.open', open),
    // AFD-259, AFD-260: the edits read the files as they are on disk at that moment.
    ...registerInventoryEdits({
      folder,
      files: async () => {
        const at = folder();
        return at ? readInventoryFiles(at, setting(at)).catch(() => undefined) : undefined;
      },
      groups: () => (tree?.groups ?? []).map((g) => g.name),
    }),
    vscode.commands.registerCommand('afd.inventory.new', create),
    vscode.workspace.onDidSaveTextDocument((doc) => onFile(doc.uri)),
    vscode.workspace.onDidCreateFiles((e) => e.files.forEach(onFile)),
    vscode.workspace.onDidDeleteFiles((e) => e.files.forEach(onFile)),
    vscode.workspace.onDidRenameFiles((e) =>
      e.files.forEach((f) => {
        onFile(f.oldUri);
        onFile(f.newUri);
      }),
    ),
    vscode.commands.registerCommand('afd.inventory.runOn', runOn),
    // Another folder, or an inventory setting changed: read it again when shown.
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (
        !e.affectsConfiguration('afd.run.inventory') &&
        !e.affectsConfiguration('afd.environment')
      )
        return;
      forget();
    }),
  ];
}

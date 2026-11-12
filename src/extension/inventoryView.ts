// The Inventory view (AFD-83, wave 8 group I): the inventory the runs use, by group, read in the
// run environment (the probe's inventory_tree), so the groups and hosts show without opening the
// files, and a run can be pointed at one (Run Flow on This Group…: the designer's launch dialog
// with it as the targets). Round 1: P6, and the inventory was the participant's most confusing part
// and the one thing to change.
import * as vscode from 'vscode';
import { inventoryCandidates, inventoryPath } from '../core/view/inventorySources';
import { type InventoryTree as Tree, type TreeGroup, topGroups } from '../core/view/inventoryTree';
import { TIMEOUTS } from '../node/timeouts';
import { environmentFor } from './env/environment';
import type { Host } from './host';
import { VIEW_TYPE } from './host';

export type InventoryItem =
  | { kind: 'group'; group: TreeGroup }
  | { kind: 'host'; host: string }
  | { kind: 'note'; text: string; command?: vscode.Command };

export function registerInventoryView(host: Host): vscode.Disposable[] {
  const changed = new vscode.EventEmitter<InventoryItem | undefined>();
  let tree: Tree | undefined;
  let problem: string | undefined;
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
      if (item.kind === 'host') {
        const t = new vscode.TreeItem(item.host);
        t.iconPath = new vscode.ThemeIcon('vm');
        t.contextValue = 'afd-host';
        return t;
      }
      const g = item.group;
      const t = new vscode.TreeItem(
        g.name,
        g.hosts.length + g.children.length > 0
          ? vscode.TreeItemCollapsibleState.Collapsed
          : vscode.TreeItemCollapsibleState.None,
      );
      t.description = `${g.count} host${g.count === 1 ? '' : 's'}`;
      t.tooltip = `${g.name}: ${g.count} host${g.count === 1 ? '' : 's'}${g.children.length ? `, groups ${g.children.join(', ')}` : ''}`;
      t.iconPath = new vscode.ThemeIcon('server-environment');
      t.contextValue = 'afd-group';
      return t;
    },
    async getChildren(parent) {
      if (parent?.kind === 'group')
        return [
          ...parent.group.children
            .map(byName)
            .filter((g): g is TreeGroup => !!g)
            .map((group): InventoryItem => ({ kind: 'group', group })),
          ...parent.group.hosts.map((h): InventoryItem => ({ kind: 'host', host: h })),
        ];
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
      return top.length
        ? top.map((group): InventoryItem => ({ kind: 'group', group }))
        : [{ kind: 'note', text: `No hosts in ${(tree as Tree).sources.join(', ')}` }];
    },
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
    vscode.commands.registerCommand('afd.inventory.refresh', () => {
      tree = undefined;
      problem = undefined;
      changed.fire(undefined);
    }),
    vscode.commands.registerCommand('afd.inventory.runOn', runOn),
    // Another folder, or an inventory setting changed: read it again when shown.
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (
        !e.affectsConfiguration('afd.run.inventory') &&
        !e.affectsConfiguration('afd.environment')
      )
        return;
      tree = undefined;
      problem = undefined;
      changed.fire(undefined);
    }),
  ];
}

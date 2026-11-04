// The Inventory view (AFD-83, wave 8 group I): the inventory the runs use, by group, read in the
// run environment (the probe's inventory_tree), so the groups and hosts show without opening the
// files, and a run can be pointed at one (Run Flow on This Group…: the designer's launch dialog
// with it as the targets). Round 1: P6, and the inventory was the participant's most confusing part
// and the one thing to change.
import * as vscode from 'vscode';
import { type InventoryTree as Tree, type TreeGroup, topGroups } from '../core/view/inventoryTree';
import { TIMEOUTS } from '../node/timeouts';
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
  return [
    changed,
    vscode.window.createTreeView('afd.inventory', { treeDataProvider: provider }),
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

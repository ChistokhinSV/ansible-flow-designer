// The inventory as the Inventory view shows it (AFD-83): groups with their own hosts and child
// groups, as the probe's inventory_tree reads them in the run environment. Pure.

export interface TreeGroup {
  name: string;
  hosts: string[];
  children: string[];
  count: number;
}

export interface InventoryTree {
  sources: string[];
  total: number;
  groups: TreeGroup[];
}

/** The groups the view starts with: the children of `all`, and `ungrouped` when it has hosts. */
export function topGroups(tree: InventoryTree): TreeGroup[] {
  const by = new Map(tree.groups.map((g) => [g.name, g]));
  const all = by.get('all');
  const names = all ? all.children : tree.groups.map((g) => g.name).filter((n) => n !== 'all');
  return names
    .map((n) => by.get(n))
    .filter((g): g is TreeGroup => !!g && (g.name !== 'ungrouped' || g.hosts.length > 0));
}

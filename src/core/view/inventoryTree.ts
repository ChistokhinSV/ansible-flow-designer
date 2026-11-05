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

/**
 * AFD-95: each group's host count and up to `max` of its hosts, its child groups' included, for
 * the launch dialog's group buttons (round 2: S2, a group was a plain button). `all` and
 * `ungrouped` are left out, as the dialog offers them.
 */
export function groupHosts(
  tree: InventoryTree,
  max = 20,
): Record<string, { count: number; hosts: string[] }> {
  const by = new Map(tree.groups.map((g) => [g.name, g]));
  const out: Record<string, { count: number; hosts: string[] }> = {};
  for (const g of tree.groups) {
    if (g.name === 'all' || g.name === 'ungrouped' || g.count === 0) continue;
    const hosts = new Set<string>();
    const seen = new Set<string>();
    const walk = (name: string) => {
      if (seen.has(name) || hosts.size >= max) return;
      seen.add(name);
      const group = by.get(name);
      for (const h of group?.hosts ?? []) if (hosts.size < max) hosts.add(h);
      for (const c of group?.children ?? []) walk(c);
    };
    walk(g.name);
    out[g.name] = { count: g.count, hosts: [...hosts] };
  }
  return out;
}

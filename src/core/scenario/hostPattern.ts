// Ansible host patterns over a scenario's inventory (AFD-114): the hosts a play or an
// inventory_target pattern selects, so the simulator knows who runs where. Names, groups, `all` and
// `*`, wildcards, unions (`:` or `,`), intersections (`&`) and exclusions (`!`), applied as Ansible
// applies them: unions first, then intersections, then exclusions. Regex (`~`) and ranges or
// slices (`[0:2]`) are not read: the result is undefined, and the scenario needs Ansible to check.

export interface Inventory {
  /** Every host, in inventory order. */
  hosts: string[];
  /** Group name → member hosts. */
  groups: Record<string, string[]>;
}

const glob = (pattern: string) =>
  new RegExp(
    `^${pattern
      .replace(/[.+^${}()|\\]/g, '\\$&')
      .replaceAll('*', '.*')
      .replaceAll('?', '.')}$`,
  );

/** The hosts one term selects: a host, a group, `all`, or a wildcard over both; undefined if unreadable. */
function term(name: string, inv: Inventory): Set<string> | undefined {
  if (!name || name.startsWith('~') || /[[\]]/.test(name)) return undefined;
  if (name === 'all' || name === '*') return new Set(inv.hosts);
  if (/[*?]/.test(name)) {
    const re = glob(name);
    const out = new Set(inv.hosts.filter((h) => re.test(h)));
    for (const [group, members] of Object.entries(inv.groups))
      if (re.test(group)) for (const h of members) out.add(h);
    return out;
  }
  const out = new Set<string>(inv.groups[name] ?? []);
  if (inv.hosts.includes(name)) out.add(name);
  return out;
}

/** The hosts a pattern selects, in inventory order; undefined when it uses what this cannot read. */
export function matchHosts(pattern: string, inv: Inventory): string[] | undefined {
  const parts = pattern
    .split(/[:,]/)
    .map((p) => p.trim())
    .filter(Boolean);
  let union = new Set<string>();
  const and: Set<string>[] = [];
  const not: Set<string>[] = [];
  for (const part of parts) {
    const kind = part[0] === '&' ? 'and' : part[0] === '!' ? 'not' : 'or';
    const hosts = term(kind === 'or' ? part : part.slice(1), inv);
    if (!hosts) return undefined;
    if (kind === 'and') and.push(hosts);
    else if (kind === 'not') not.push(hosts);
    else union = new Set([...union, ...hosts]);
  }
  // A pattern of only intersections or exclusions starts from no host, as Ansible's does.
  return inv.hosts.filter(
    (h) => union.has(h) && and.every((s) => s.has(h)) && not.every((s) => !s.has(h)),
  );
}

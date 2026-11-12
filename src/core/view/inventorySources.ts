// AFD-256: Switch Inventory…. The inventories a repository holds, found by where Ansible
// repositories keep them: a file at the root, a folder `inventory/`, one folder or file for each
// environment under `inventories/`. Pure: file paths in (relative), candidates out. Whether a
// candidate reads is Ansible's to say, when it is picked.

const ROOT_FILE = /^(hosts|inventory)([._-][\w.-]+)?$/i;
/** Not inventories, whatever they are called. */
const OTHER = /\.(md|txt|bak|orig|swp|tmp|log|j2|retry)$/i;
const VARS = /(^|\/)(group_vars|host_vars)(\/|$)/;
const FOLDERS = ['inventory', 'inventories'];

const slashes = (path: string) => path.split('\\').join('/');

export function inventoryCandidates(files: readonly string[]): string[] {
  const dirs = new Set<string>();
  const found = new Set<string>();
  for (const raw of files) {
    const path = slashes(raw).replace(/^\.\//, '');
    if (!path || VARS.test(path) || OTHER.test(path)) continue;
    const parts = path.split('/');
    const name = parts.at(-1) as string;
    if (name.startsWith('.')) continue;
    if (parts.length === 1) {
      if (ROOT_FILE.test(name)) found.add(path);
      continue;
    }
    const top = parts[0] as string;
    if (!FOLDERS.includes(top.toLowerCase())) continue;
    // A file right in the folder is an inventory of its own; `inventory/` is also all of its
    // files together. Deeper, the folder is the inventory (inventories/prod/hosts.yml). Files of
    // group_vars and host_vars alone make no inventory: they were left out above.
    if (parts.length === 2) {
      found.add(path);
      if (top.toLowerCase() === 'inventory') dirs.add(top);
    } else dirs.add(`${top}/${parts[1]}`);
  }
  const sorted = (set: Set<string>) => [...set].sort((a, b) => a.localeCompare(b));
  return [...sorted(dirs), ...sorted(found)];
}

/** The setting as a path of the list: forward slashes, no `./`, no trailing `/`. */
export function inventoryPath(setting: string): string {
  return slashes(setting.trim()).replace(/^\.\//, '').replace(/\/+$/, '');
}

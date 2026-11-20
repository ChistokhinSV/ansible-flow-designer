// AFD-340: a repository held in memory (paths from the root to texts) as an InventoryFs: the
// webview harness's fake repository and the unit tests read through it; a host with the files at
// hand (Ansible Flow Server, phase 4) can too.
import type { InventoryFs } from './files';

export function memoryFs(files: Readonly<Record<string, string>>): InventoryFs {
  const dirs = new Set<string>(['']);
  for (const p of Object.keys(files)) {
    const parts = p.split('/');
    for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/'));
  }
  return {
    read: async (p) => (Object.hasOwn(files, p) ? files[p] : undefined),
    kind: async (p) => (Object.hasOwn(files, p) ? 'file' : dirs.has(p) ? 'dir' : undefined),
    list: async (p) => {
      if (!dirs.has(p)) return undefined;
      const pre = p ? `${p}/` : '';
      const names = new Map<string, boolean>();
      for (const f of [...Object.keys(files), ...dirs]) {
        if (!f.startsWith(pre) || f === p) continue;
        const name = f.slice(pre.length).split('/')[0] as string;
        names.set(name, (names.get(name) ?? false) || dirs.has(`${pre}${name}`));
      }
      return [...names]
        .map(([name, dir]) => ({ name, dir }))
        .sort((a, b) => a.name.localeCompare(b.name));
    },
  };
}

// Catalog dump files on this machine (AFD-134): the probe names them after the collections
// installed in the environment, and the extension reads and deletes them in its cache.
import { isAbsolute, relative, resolve } from 'node:path';
import type { Manifest } from '../../core/catalog/types';

/**
 * A dump's name as the probe makes it: `<core minor>/<namespace>.<name>@<version>.json` (AFD-134).
 * Names and versions come from the collections installed in the environment, which a repository
 * or an image chooses, and the extension deletes and reads these files on this machine.
 */
const DUMP_FILE = /^\d+\.\d+\/[\w-]+\.[\w-]+@[\w.+*-]+\.json$/;

/** The manifest with every collection whose file would not name a dump inside `cache` failed. */
export function checkedManifest(manifest: Manifest, cache: string): Manifest {
  const root = resolve(cache);
  return {
    ...manifest,
    collections: manifest.collections.map((c) => {
      const file = typeof c.file === 'string' ? c.file : '';
      const rel = relative(root, resolve(root, file));
      const inside = rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
      return DUMP_FILE.test(file) && inside
        ? c
        : { ...c, file: '', error: c.error ?? `not a dump name the catalog accepts: ${file}` };
    }),
  };
}

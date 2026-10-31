import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { SourceIO } from '../../../src/core/import/read';

export const EXAMPLES_DIR = join(__dirname, '../../../examples');
export const FIXTURES_DIR = join(__dirname, '../../fixtures/flows');

export function exampleFlows(): { name: string; text: string }[] {
  return readdirSync(EXAMPLES_DIR)
    .filter((f) => f.endsWith('.flow.yaml'))
    .map((name) => ({ name, text: readFileSync(join(EXAMPLES_DIR, name), 'utf8') }));
}

export function readExample(name: string): string {
  return readFileSync(join(EXAMPLES_DIR, name), 'utf8');
}

export function readFixture(name: string): string {
  return readFileSync(join(FIXTURES_DIR, name), 'utf8');
}

/** The fictional repository the import tests read (AFD-26). */
export const NETOPS = join(__dirname, '../../fixtures/import/netops');

/** A SourceIO over a folder on disk (repository paths relative to `root`). */
export function fsSource(root: string): SourceIO {
  return {
    async read(path) {
      const full = join(root, path);
      return existsSync(full) && statSync(full).isFile() ? readFileSync(full, 'utf8') : undefined;
    },
    async list(dir) {
      const full = join(root, dir);
      if (!existsSync(full) || !statSync(full).isDirectory()) return [];
      return readdirSync(full, { withFileTypes: true }).map((e) => ({
        name: e.name,
        dir: e.isDirectory(),
      }));
    },
    async exists(path) {
      return existsSync(join(root, path));
    },
  };
}

// AFD-171: editors on Node before 22.13 (VS Code forks on an older Electron) have no node:sqlite.
// The extension must still load there, with the module catalog off and saying why.
import { afterEach, describe, expect, it, vi } from 'vitest';

type Index = typeof import('../../../src/node/catalog/catalogIndex');

async function loadIndex(withSqlite: boolean): Promise<Index> {
  vi.resetModules();
  if (!withSqlite) {
    const real = process.getBuiltinModule.bind(process);
    vi.spyOn(process, 'getBuiltinModule').mockImplementation(((id: string) =>
      id === 'node:sqlite' ? undefined : real(id)) as typeof process.getBuiltinModule);
  }
  return import('../../../src/node/catalog/catalogIndex');
}

describe('catalog without node:sqlite', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('loads, reports the catalog off and refuses to build', async () => {
    const m = await loadIndex(false);
    expect(m.sqliteAvailable()).toBe(false);
    expect(m.sqliteMissing()).toContain('22.13');
    expect(() => m.CatalogIndex.build(':memory:', [])).toThrow(/Node\.js 22\.13/);
    expect(m.CatalogIndex.open('missing.db')).toBeUndefined();
  });

  it('works where the runtime has it', async () => {
    const m = await loadIndex(true);
    expect(m.sqliteAvailable()).toBe(true);
    const index = m.CatalogIndex.build(':memory:', []);
    expect(index.stats().plugins).toBe(0);
    index.close();
  });
});

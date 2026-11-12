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

describe('plugin names for the Jinja completion list (AFD-225)', () => {
  it("lists a type's plugins: ansible.builtin's by short name first, a collection's by FQCN", async () => {
    const m = await loadIndex(true);
    const plugin = (collection: string, name: string, type: string, short: string) => ({
      type,
      fqcn: `${collection}.${name}`,
      collection,
      name,
      short_description: short,
      description: short,
      notes: '',
      requirements: '',
      deprecated: null,
      options: {},
      returns: {},
      examples: '',
      attributes: {},
    });
    const file = (collection: string, plugins: unknown[]) =>
      ({ format: 1, collection, version: '1.0.0', plugins, routing: {}, errors: [] }) as never;
    const index = m.CatalogIndex.build(':memory:', [
      file('community.general', [
        plugin('community.general', 'json_query', 'filter', 'Query JSON.'),
      ]),
      file('ansible.builtin', [
        plugin('ansible.builtin', 'to_datetime', 'filter', 'Get a datetime from text.'),
        plugin('ansible.builtin', 'env', 'lookup', 'Read an environment variable.'),
      ]),
      file('ansible.legacy', [plugin('ansible.legacy', 'to_datetime', 'filter', 'Again.')]),
    ]);
    expect(index.names('filter')).toEqual([
      {
        name: 'to_datetime',
        fqcn: 'ansible.builtin.to_datetime',
        doc: 'Get a datetime from text.',
      },
      {
        name: 'community.general.json_query',
        fqcn: 'community.general.json_query',
        doc: 'Query JSON.',
      },
    ]);
    expect(index.names('lookup').map((p) => p.name)).toEqual(['env']);
    expect(index.names('test')).toEqual([]);
    index.close();
  });
});

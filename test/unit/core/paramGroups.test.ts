// AFD-80: the Binding tab's Configure groups (required, set, added, the rest) and the parameter
// picker's search, on the shape of ansible.builtin.lineinfile's docs (round 1: P1 looked up `line`
// and `state` on the web because they were not in the form).
import { describe, expect, it } from 'vitest';
import { filterParams, paramGroups } from '../../../src/core/catalog/draft';
import type { CatalogOption } from '../../../src/core/catalog/types';

const opt = (description: string, more: Partial<CatalogOption> = {}): CatalogOption => ({
  type: 'str',
  description,
  ...more,
});

const LINEINFILE: Record<string, CatalogOption> = {
  backup: opt('Create a backup file including the timestamp information.', { type: 'bool' }),
  create: opt(
    'Used with state=present. If specified, the file will be created if it does not already exist.',
    { type: 'bool' },
  ),
  line: opt('The line to insert/replace into the file.', { aliases: ['value'] }),
  mode: opt('The permissions the resulting filesystem object should have.'),
  path: opt('The file to modify.', {
    type: 'path',
    required: true,
    aliases: ['dest', 'destfile', 'name'],
  }),
  regexp: opt('The regular expression to look for in every line of the file.', {
    aliases: ['regex'],
  }),
  state: opt('Whether the line should be there or not.', {
    choices: ['absent', 'present'],
    default: 'present',
  }),
};

const names = (fs: { name: string }[]) => fs.map((f) => f.name);

describe('paramGroups', () => {
  it('a new binding: the required parameter, nothing set, the rest for the picker', () => {
    const g = paramGroups(LINEINFILE, {});
    expect(names(g.required)).toEqual(['path']);
    expect(g.set).toEqual([]);
    expect(g.added).toEqual([]);
    expect(names(g.rest)).toEqual(['backup', 'create', 'line', 'mode', 'regexp', 'state']);
  });

  it('a value moves a parameter to Set, an alias counts, an added one waits in Added', () => {
    const g = paramGroups(LINEINFILE, { path: '/etc/issue.net', value: 'Authorized only' }, [
      'state',
      'mode',
    ]);
    expect(names(g.required)).toEqual(['path']);
    expect(names(g.set)).toEqual(['line']);
    expect(names(g.added)).toEqual(['state', 'mode']);
    expect(names(g.rest)).toEqual(['backup', 'create', 'regexp']);
  });

  it('a parameter with a default is not required', () => {
    expect(
      names(paramGroups({ state: opt('x', { required: true, default: 'present' }) }, {}).required),
    ).toEqual([]);
  });
});

describe('filterParams', () => {
  const fields = paramGroups(LINEINFILE, {}).rest;

  it('finds by name first, then alias, then description, in the docs order', () => {
    expect(names(filterParams(fields, 'line'))).toEqual(['line', 'regexp', 'state']);
    expect(names(filterParams(fields, 'regex'))).toEqual(['regexp']);
    expect(names(filterParams(fields, 'value'))).toEqual(['line']);
    expect(names(filterParams(fields, 'permissions'))).toEqual(['mode']);
  });

  it('an empty query keeps every parameter; no match gives none', () => {
    expect(filterParams(fields, '  ')).toHaveLength(fields.length);
    expect(filterParams(fields, 'zzz')).toEqual([]);
  });
});

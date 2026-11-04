// AFD-83: the Inventory view starts from the groups under `all`; `ungrouped` only with hosts.
import { describe, expect, it } from 'vitest';
import { topGroups } from '../../../src/core/view/inventoryTree';

const g = (name: string, hosts: string[] = [], children: string[] = []) => ({
  name,
  hosts,
  children,
  count: hosts.length,
});

describe('topGroups', () => {
  it('the children of all, in order; an empty ungrouped is left out', () => {
    const tree = {
      sources: ['inventory/lab.ini'],
      total: 5,
      groups: [
        g('all', [], ['core', 'lab', 'ungrouped']),
        g('core', ['core-sp-01']),
        g('lab', ['lab-sw-01', 'lab-sw-02']),
        g('ungrouped'),
      ],
    };
    expect(topGroups(tree).map((x) => x.name)).toEqual(['core', 'lab']);
    tree.groups[3] = g('ungrouped', ['stray-01']);
    expect(topGroups(tree).map((x) => x.name)).toEqual(['core', 'lab', 'ungrouped']);
  });
});

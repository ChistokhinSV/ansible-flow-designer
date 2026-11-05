// AFD-83: the Inventory view starts from the groups under `all`; `ungrouped` only with hosts.
import { describe, expect, it } from 'vitest';
import { groupHosts, topGroups } from '../../../src/core/view/inventoryTree';

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

describe('groupHosts (AFD-95)', () => {
  it("each group's count and its hosts, its children's included; all and ungrouped left out", () => {
    const tree = {
      sources: ['inventory/lab.ini'],
      total: 3,
      groups: [
        g('all', [], ['dc', 'ungrouped']),
        { ...g('dc', [], ['core', 'lab']), count: 3 },
        g('core', ['core-sp-01']),
        g('lab', ['lab-sw-01', 'lab-sw-02']),
        g('ungrouped'),
      ],
    };
    expect(groupHosts(tree)).toEqual({
      dc: { count: 3, hosts: ['core-sp-01', 'lab-sw-01', 'lab-sw-02'] },
      core: { count: 1, hosts: ['core-sp-01'] },
      lab: { count: 2, hosts: ['lab-sw-01', 'lab-sw-02'] },
    });
    expect(groupHosts(tree, 2).dc).toEqual({ count: 3, hosts: ['core-sp-01', 'lab-sw-01'] });
  });
});

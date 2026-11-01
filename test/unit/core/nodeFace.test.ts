// AFD-42: the canvas writes the module a node runs under its title, and labels only the wires off
// the normal path at rest.
import { describe, expect, it } from 'vitest';
import type { FlowNode } from '../../../src/core/flow/types';
import { labelledAtRest, subLine } from '../../../src/core/view/nodeFace';

const node = (more: Partial<FlowNode>): FlowNode =>
  ({ id: '01JD0000000000000000000001', key: 'n', type: 'task', title: 'N', ...more }) as FlowNode;

describe('node face (AFD-42)', () => {
  it('the sub-line names the bound module or role, else the kind of node', () => {
    expect(subLine(node({}))).toBe('Task');
    expect(subLine(node({ handler: 'rollback' }))).toBe('Task · rollback');
    expect(
      subLine(node({ impl: { kind: 'module', ref: 'ansible.builtin.copy', params: {} } })),
    ).toBe('ansible.builtin.copy');
    expect(subLine(node({ type: 'subflow' }))).toBe('Subflow');
    expect(subLine(node({ type: 'decision', condition: 'site == "lab"' }))).toBe(
      'if site == "lab"',
    );
  });

  it('wires on the normal path are quiet at rest; the others say which port they leave by', () => {
    for (const quiet of ['ok_hosts', 'approved']) expect(labelledAtRest(quiet)).toBe(false);
    for (const loud of ['failed_hosts', 'unreachable', 'timeout', 'rejected', 'true', 'false'])
      expect(labelledAtRest(loud)).toBe(true);
    expect(labelledAtRest('branch_2')).toBe(true);
    expect(labelledAtRest('always')).toBe(true);
  });
});

import { describe, expect, it } from 'vitest';
import {
  defaultPortNames,
  isPortLegal,
  optionalPortNames,
  portSpec,
  portsFor,
} from '../../../src/core/flow/ports';
import { NODE_TYPES, type NodeType } from '../../../src/core/flow/types';

// ADR-0004 port catalog: the spec of M1 acceptance check 3.
const CATALOG: Record<NodeType, { defaults: string[]; optional: string[] }> = {
  start: { defaults: ['ok_hosts'], optional: [] },
  end: { defaults: ['in'], optional: [] },
  task: {
    defaults: ['in', 'ok_hosts', 'failed_hosts'],
    optional: ['unreachable', 'unchanged', 'always', 'cancelled', 'timeout', 'undo'],
  },
  subflow: {
    defaults: ['in', 'ok_hosts', 'failed_hosts'],
    optional: ['unreachable', 'unchanged', 'always', 'cancelled', 'timeout', 'undo'],
  },
  decision: { defaults: ['in', 'true', 'false'], optional: [] },
  approval: { defaults: ['in', 'approved', 'rejected'], optional: ['timeout'] },
  parallel: { defaults: ['in', 'branch_1', 'branch_2'], optional: [] },
  join: { defaults: ['in', 'ok_hosts'], optional: ['failed_hosts'] },
};

describe('port catalog', () => {
  it.each(NODE_TYPES)('%s has exactly the catalog defaults and optionals', (type) => {
    expect(defaultPortNames({ type })).toEqual(CATALOG[type].defaults);
    expect([...optionalPortNames(type)]).toEqual(CATALOG[type].optional);
    expect(portsFor({ type }).map((p) => p.name)).toEqual(CATALOG[type].defaults);
  });

  it('adds enabled optional ports and ignores illegal ones', () => {
    const ports = portsFor({ type: 'task', ports: ['undo', 'unreachable', 'approved'] });
    expect(ports.map((p) => p.name)).toEqual([
      'in',
      'ok_hosts',
      'failed_hosts',
      'unreachable',
      'undo',
    ]);
    expect(ports.filter((p) => p.optional).map((p) => p.name)).toEqual(['unreachable', 'undo']);
  });

  it('derives parallel branch ports from `branches`', () => {
    expect(defaultPortNames({ type: 'parallel', branches: 4 })).toEqual([
      'in',
      'branch_1',
      'branch_2',
      'branch_3',
      'branch_4',
    ]);
    expect(isPortLegal({ type: 'parallel', branches: 3 }, 'branch_3')).toBe(true);
    expect(isPortLegal({ type: 'parallel', branches: 3 }, 'branch_4')).toBe(false);
  });

  it('places ports per D-12 and marks fail-type ports', () => {
    expect(portSpec('in').side).toBe('top');
    expect(portSpec('ok_hosts').side).toBe('bottom');
    expect(portSpec('failed_hosts')).toMatchObject({ side: 'right', fail: true, tone: 'failed' });
    expect(portSpec('unreachable')).toMatchObject({ side: 'right', fail: true });
    expect(portSpec('rejected')).toMatchObject({ side: 'right', fail: true });
    expect(portSpec('undo')).toMatchObject({ side: 'left', direction: 'in', fail: false });
    expect(portSpec('unchanged').fail).toBe(false);
  });
});

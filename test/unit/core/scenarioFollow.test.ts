// AFD-115: a scenarios file follows the flow: renamed steps, ends and subflows, and steps moved into
// a subflow, are rewritten in its force, approvals and expect, byte-preserving; gone ones stay.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { planCommand } from '../../../src/core/flow/commands';
import { createIdFactory } from '../../../src/core/flow/ids';
import { buildModel } from '../../../src/core/flow/model';
import type { FlowDocument } from '../../../src/core/flow/types';
import { followPaths, pathChanges } from '../../../src/core/scenario/follow';
import { checkScenarios, parseScenarios } from '../../../src/core/scenario/scenarios';

const FIX = join(__dirname, '../../fixtures/engine');
const FLOW = readFileSync(join(FIX, 'routing-levels.flow.yaml'), 'utf8');
const SCENARIOS = readFileSync(join(FIX, 'routing-levels.scenarios.yaml'), 'utf8');
const doc = (text: string) => parse(text) as FlowDocument;
const id = (key: string) =>
  [...buildModel(doc(FLOW)).nodes.values()].find((n) => n.node.key === key)?.node.id as string;
const run = (cmd: Parameters<typeof planCommand>[1]) =>
  planCommand(FLOW, cmd, { newId: createIdFactory() }).text;

describe('scenarios follow the flow (AFD-115)', () => {
  it('renames a step in force and expect, and keeps the rest of the file as it was', () => {
    const after = run({ kind: 'updateNode', id: id('gate'), patch: { key: 'final-gate' } });
    const out = followPaths(SCENARIOS, pathChanges(doc(FLOW), doc(after)));
    expect(out?.notes).toEqual([
      'gate → final-gate',
      'gate.failed_hosts → final-gate.failed_hosts',
    ]);
    expect(out?.text).toBe(
      SCENARIOS.replace('      gate:\n', '      final-gate:\n').replace(
        'h03: gate.failed_hosts',
        'h03: final-gate.failed_hosts',
      ),
    );
    const file = parseScenarios(out?.text ?? '').file;
    if (!file) throw new Error('parse');
    expect(checkScenarios(doc(after), file)).toEqual([]);
  });

  it('renames the paths inside a renamed subflow, and an end', () => {
    let after = run({ kind: 'updateNode', id: id('stage'), patch: { key: 'prep' } });
    after = planCommand(
      after,
      { kind: 'updateNode', id: id('done'), patch: { key: 'finished' } },
      { newId: createIdFactory() },
    ).text;
    const out = followPaths(SCENARIOS, pathChanges(doc(FLOW), doc(after)));
    expect(out?.text).toContain('      prep/prepare:\n');
    expect(out?.text).not.toContain('h01: done');
    expect(out?.text).toContain('h01: finished');
    const file = parseScenarios(out?.text ?? '').file;
    if (!file) throw new Error('parse');
    expect(checkScenarios(doc(after), file)).toEqual([]);
  });

  it('follows a step moved into a new subflow', () => {
    const after = run({ kind: 'extractSubflow', nodes: [id('gate')], title: 'Final checks' });
    const changes = pathChanges(doc(FLOW), doc(after));
    const [, moved] = [...changes.moved].find(([from]) => from === 'gate') ?? [];
    expect(moved).toMatch(/^[a-z0-9-]+\/gate$/);
    const out = followPaths(SCENARIOS, changes);
    expect(out?.text).toContain(`      ${moved}:\n`);
  });

  it('leaves a deleted step for the check to name, and a file that does not parse alone', () => {
    const after = run({ kind: 'deleteNode', id: id('gate') });
    const changes = pathChanges(doc(FLOW), doc(after));
    expect([...changes.gone]).toEqual(['gate']);
    expect(followPaths(SCENARIOS, changes)).toBeUndefined();
    expect(followPaths('scenarios: [', { moved: new Map([['a', 'b']]), gone: new Set() })).toBe(
      undefined,
    );
  });
});

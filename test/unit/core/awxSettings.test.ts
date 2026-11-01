// AFD-52 part 2: the AWX template's credentials and execution environment belong to the flow in
// format 2. The upgrade (and an import) moves what nodes named; format 2 warns about one left on a
// node; the Access lens reads the flow's.
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { awxLift, withAwxRuntime } from '../../../src/core/flow/awxSettings';
import { type FlowCommand, planCommand } from '../../../src/core/flow/commands';
import { createIdFactory } from '../../../src/core/flow/ids';
import { upgradeNotes } from '../../../src/core/flow/migrate';
import type { FlowDocument } from '../../../src/core/flow/types';
import { validateFlow } from '../../../src/core/flow/validate';
import { accessLens } from '../../../src/core/lens/access';
import { readExample } from './helpers';

const ctx = { newId: createIdFactory() };
const V1 = readExample('edge-baseline.flow.yaml');
const run = (text: string, cmd: FlowCommand) => planCommand(text, cmd, ctx).text;
const doc = (text: string) => parse(text) as FlowDocument;
const id = (text: string, key: string) => doc(text).nodes.find((n) => n.key === key)?.id as string;
const named = (text: string) => {
  const a = run(text, {
    kind: 'updateNode',
    id: id(text, 'precheck'),
    patch: { settings: { credential: 'Edge switches', execution_environment: 'Netops EE' } },
  });
  return run(a, {
    kind: 'updateNode',
    id: id(a, 'validate'),
    patch: { settings: { credential: 'Edge vault', execution_environment: 'Other EE' } },
  });
};

describe('credentials and execution environment on the flow (format 2)', () => {
  it('the upgrade moves what nodes named to the flow, says so, and keeps one environment', () => {
    const v1 = named(V1);
    expect(awxLift(doc(v1))).toMatchObject({
      credentials: ['Edge switches', 'Edge vault'],
      execution_environment: 'Netops EE',
      otherEnvironments: ['Other EE'],
    });
    const notes = upgradeNotes(doc(v1));
    expect(notes).toContain(
      'credentials Edge switches, Edge vault and execution environment Netops EE move from 2 nodes to the flow, where Set Up AWX Template applies them',
    );
    expect(notes).toContain('execution environment Other EE is dropped (one per template)');
    const up = doc(run(v1, { kind: 'upgradeFormat' }));
    expect(up.flow.runtime).toEqual({
      template: 'AFD · edge-baseline',
      credentials: ['Edge switches', 'Edge vault'],
      execution_environment: 'Netops EE',
    });
    for (const n of up.nodes) {
      expect(n.settings?.credential).toBeUndefined();
      expect(n.settings?.execution_environment).toBeUndefined();
    }
  });

  it('format 2 warns about a credential left on a node; the Access lens reads the flow', () => {
    const v2 = run(V1, { kind: 'upgradeFormat' });
    const stray = run(v2, {
      kind: 'updateNode',
      id: id(v2, 'precheck'),
      patch: { settings: { credential: 'Edge switches' } },
    });
    expect(validateFlow(doc(stray)).findings.map((f) => f.code)).toContain('setting-on-flow');
    const withCreds = {
      ...doc(v2),
      flow: { ...doc(v2).flow, runtime: { template: 'T', credentials: ['Edge switches'] } },
    };
    const lens = accessLens(withCreds, undefined);
    const chips = Object.values(lens.chips)
      .flat()
      .map((c) => c.text);
    expect(chips).toContain('Edge switches');
  });

  it('an import in format 2 keeps the template settings on the flow, in the designer’s order', () => {
    const flow = withAwxRuntime({
      ...doc(named(V1)),
      schema_version: 2,
    });
    expect(Object.keys(flow.flow).indexOf('runtime')).toBeLessThan(
      Object.keys(flow.flow).indexOf('inputs'),
    );
    expect(flow.flow.runtime?.credentials).toEqual(['Edge switches', 'Edge vault']);
  });
});

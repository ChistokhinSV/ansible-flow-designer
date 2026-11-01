// AFD-55: a rolling subflow sends its hosts through every step inside in batches: its level is one
// play with serial, each step a block for the hosts that arrived at it.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { optionA } from '../../../src/core/engine/optionA';
import type { FlowDocument, FlowNode } from '../../../src/core/flow/types';
import { validateFlow } from '../../../src/core/flow/validate';
import { EXECUTION_SETTINGS, settingProblem, settingValue } from '../../../src/core/view/settings';

const LEVELS = readFileSync(
  join(__dirname, '../../fixtures/engine/routing-levels.flow.yaml'),
  'utf8',
);
const rolling = (batch: number | string, inner?: (nodes: FlowNode[]) => void) => {
  const doc = parse(LEVELS) as FlowDocument;
  const stage = doc.nodes.find((n) => n.key === 'stage') as FlowNode;
  stage.settings = { ...stage.settings, rolling: batch };
  inner?.(stage.subflow?.nodes ?? []);
  return doc;
};
type Play = { name: string; serial?: unknown; tasks?: Record<string, unknown>[] };
const stageFile = (doc: FlowDocument) => {
  const r = optionA.generate(doc, { source: 'x' });
  const file = r.files.find((f) => f.name.endsWith('.stage.yml'));
  return { r, plays: parse(file?.text ?? '') as Play[] };
};

describe('rolling subflows (AFD-55)', () => {
  it('compiles the level into one play with serial; each step is a block for its arrivals', () => {
    const { r, plays } = stageFile(rolling('25%'));
    expect(r.findings.filter((f) => f.code === 'rolling-unsupported')).toEqual([]);
    expect(plays).toHaveLength(1);
    expect(plays[0]).toMatchObject({
      name: '[stage] Stage: rolling, 25% at a time',
      serial: '25%',
    });
    const [prepare, connect] = plays[0]?.tasks ?? [];
    expect(prepare).toMatchObject({
      name: '[prepare] Prepare',
      tags: ['node_01JCR2N0000000000000000007'],
    });
    expect(prepare?.when).toBeUndefined(); // the entry: every host of the play arrives
    expect(connect).toMatchObject({
      name: '[connect] Connect',
      when: "inventory_hostname in (groups['flow_stage__prepare_ok_hosts'] | default([]))",
      vars: { flow_node_id: '01JCR2N0000000000000000008' },
    });
    // The routing inside is the step's own: block, rescue and the groups the other levels read.
    expect(JSON.stringify(connect?.block)).toContain('flow_stage_failed_hosts');
  });

  it('a step that needs plays of its own: an error, and the steps run play by play', () => {
    const doc = rolling(2, (nodes) => {
      const connect = nodes.find((n) => n.key === 'connect') as FlowNode;
      connect.settings = { serial: 1 };
    });
    const { r, plays } = stageFile(doc);
    expect(r.findings.find((f) => f.code === 'rolling-unsupported')?.message).toContain(
      'Connect: serial batches a play of its own',
    );
    expect(plays.length).toBeGreaterThan(1);
    expect(plays.every((p) => p.serial !== 2)).toBe(true);
    const found = validateFlow(doc).findings.filter((f) => f.code === 'rolling-unsupported');
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ severity: 'error', node: '01JCR2N0000000000000000008' });
    // Rolling a task does nothing: a warning.
    const task = parse(LEVELS) as FlowDocument;
    (task.nodes.find((n) => n.key === 'gate') as FlowNode).settings = { rolling: 2 };
    expect(validateFlow(task).findings.find((f) => f.code === 'rolling-unsupported')).toMatchObject(
      { severity: 'warning' },
    );
    expect(validateFlow(rolling(2)).findings.map((f) => f.code)).not.toContain(
      'rolling-unsupported',
    );
  });

  it('the Execution tab offers it on subflows: a number or a percentage', () => {
    const field = EXECUTION_SETTINGS.find((s) => s.key === 'rolling');
    if (!field) throw new Error('no rolling field');
    expect(field.types).toEqual(['subflow']);
    expect(settingValue(field, '3')).toBe(3);
    expect(settingValue(field, '25%')).toBe('25%');
    expect(settingProblem(field, '0')).toBeDefined();
    expect(settingProblem(field, 'half')).toBeDefined();
    expect(settingProblem(field, '10%')).toBeUndefined();
  });
});

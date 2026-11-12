// AFD-244: the flow a partial run executes: from a step on, or one step alone.
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { optionA } from '../../../src/core/engine/optionA';
import { partialFlow, partialLine, partialProblem } from '../../../src/core/engine/partial';
import { buildModel } from '../../../src/core/flow/model';
import { createSchemaValidator } from '../../../src/core/flow/schema';
import type { FlowDocument } from '../../../src/core/flow/types';
import { simulateRun } from '../../../src/core/scenario/simulate';
import { readExample } from './helpers';

const EDGE = parse(readExample('edge-baseline.flow.yaml')) as FlowDocument;
const OS = parse(readExample('os-upgrade.flow.yaml')) as FlowDocument;
const schema = createSchemaValidator();
const id = (doc: FlowDocument, key: string) =>
  [...buildModel(doc).nodes.values()].find((e) => e.node.key === key)?.node.id as string;
const keys = (doc: FlowDocument) => doc.nodes.map((n) => n.key);
const wires = (doc: FlowDocument) => {
  const k = new Map(doc.nodes.map((n) => [n.id, n.key]));
  return (doc.edges ?? [])
    .map((e) => `${k.get(e.from.node)}.${e.from.port} -> ${k.get(e.to.node)}`)
    .sort();
};
const made = (doc: FlowDocument, key: string, only = false) => {
  const r = partialFlow(doc, { node: id(doc, key), only });
  if ('error' in r) throw new Error(r.error);
  expect(schema(r.doc)).toEqual([]);
  return r;
};

describe('Run from Here (AFD-244)', () => {
  it('the hosts start at the step; what is before it is not in the run', () => {
    const r = made(EDGE, 'push-baseline');
    expect(keys(r.doc)).toEqual([
      'start',
      'push-baseline',
      'validate',
      'rollback',
      'done',
      'failed',
    ]);
    expect(wires(r.doc)).toEqual([
      'push-baseline.failed_hosts -> rollback',
      'push-baseline.ok_hosts -> validate',
      'rollback.ok_hosts -> failed',
      'start.ok_hosts -> push-baseline',
      'validate.ok_hosts -> done',
    ]);
    expect(r.skipped).toBe(2);
    // The flow given is untouched.
    expect(keys(EDGE)).toContain('precheck');
  });

  it('steps that read a step left out run as stubs, and the run says so', () => {
    const r = made(EDGE, 'push-baseline');
    expect(r.stubbed.map((s) => [s.title, s.reads])).toEqual([
      ['Push baseline', ['backup-config.backup_ref']],
    ]);
    // Rollback read it too, but has no binding: it was a stub already.
    const push = r.doc.nodes.find((n) => n.key === 'push-baseline');
    expect(push?.impl).toBeUndefined();
    expect(push?.inputs?.backup_ref?.from).toBeUndefined();
    expect(partialLine('Push baseline', false, r)).toBe(
      'Ran from "Push baseline"; 2 steps before it did not run. As stubs, since they read a step that did not run: Push baseline',
    );
  });

  it('it generates, and the simulated hosts go from the step to the end', () => {
    const r = made(EDGE, 'validate');
    const built = optionA.generate(r.doc, { source: 'edge-baseline.flow.yaml' });
    expect(built.ok).toBe(true);
    expect(built.plays[id(EDGE, 'validate')]).toBeDefined();
    expect(built.plays[id(EDGE, 'precheck')]).toBeUndefined();
    const sim = simulateRun(r.doc, { inputs: { devices: ['sw1'] } });
    expect(sim.error).toBeUndefined();
    expect(Object.keys(sim.summary?.nodes ?? {})).toContain(id(EDGE, 'validate'));
    expect(Object.keys(sim.summary?.nodes ?? {})).not.toContain(id(EDGE, 'push-baseline'));
  });

  it('from the first step: the whole flow, nothing left out', () => {
    const r = made(EDGE, 'precheck');
    expect(r.skipped).toBe(0);
    expect(r.stubbed).toEqual([]);
    expect(wires(r.doc)).toEqual(wires(EDGE));
  });
});

describe('Run This Step (AFD-244)', () => {
  it('the step alone, between Start and a successful end', () => {
    const r = made(EDGE, 'validate', true);
    expect(keys(r.doc)).toEqual(['start', 'validate', 'done', 'failed']);
    expect(wires(r.doc)).toEqual(['start.ok_hosts -> validate', 'validate.ok_hosts -> done']);
    expect(partialLine('Validate', true, r)).toBe(
      'Ran "Validate" alone; 4 steps before it did not run',
    );
  });

  it('a subflow runs with its inner steps', () => {
    const r = made(OS, 'upgrade-os', true);
    expect(keys(r.doc).filter((k) => k === 'upgrade-os')).toHaveLength(1);
    const built = optionA.generate(r.doc, { source: 'os-upgrade.flow.yaml' });
    expect(built.ok).toBe(true);
    expect(built.plays[id(OS, 'reload')]).toBeDefined();
  });
});

describe('where a partial run can start', () => {
  it('a top-level step only', () => {
    expect(partialProblem(EDGE, id(EDGE, 'validate'))).toBeUndefined();
    expect(partialProblem(EDGE, id(EDGE, 'start'))).toMatch(/not at a start or end/);
    expect(partialProblem(OS, id(OS, 'reload'))).toMatch(/top level/);
    expect(partialFlow(OS, { node: id(OS, 'reload'), only: false })).toEqual({
      error: 'A run starts at a step of the top level: open the top level',
    });
  });
});

// AFD-242 (ADR-0035): a disabled node does nothing. The field and its commands, the flow the
// generator and the simulator see, and what validation says.
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { withoutDisabled } from '../../../src/core/engine/bypass';
import { optionA } from '../../../src/core/engine/optionA';
import { CommandError, type FlowCommand, planCommand } from '../../../src/core/flow/commands';
import { createIdFactory } from '../../../src/core/flow/ids';
import { buildModel } from '../../../src/core/flow/model';
import { openFailPorts } from '../../../src/core/flow/openPorts';
import { createSchemaValidator } from '../../../src/core/flow/schema';
import type { FlowDocument, FlowNode } from '../../../src/core/flow/types';
import { validateFlow } from '../../../src/core/flow/validate';
import { simulateRun } from '../../../src/core/scenario/simulate';
import { matchesFilters, parseFind } from '../../../src/core/view/findQuery';
import { subLine } from '../../../src/core/view/nodeFace';
import { applyEdits } from '../../../src/core/yaml';
import { readExample } from './helpers';

const EDGE = readExample('edge-baseline.flow.yaml');
const OS = readExample('os-upgrade.flow.yaml');
const schema = createSchemaValidator();
const ctx = { newId: createIdFactory() };
const docOf = (text: string) => parse(text) as FlowDocument;
const apply = (text: string, cmd: FlowCommand) => {
  const r = planCommand(text, cmd, ctx);
  expect(applyEdits(text, r.edits)).toBe(r.text);
  expect(schema(docOf(r.text))).toEqual([]);
  return r.text;
};
const all = (text: string): FlowNode[] =>
  [...buildModel(docOf(text)).nodes.values()].map((e) => e.node);
const id = (text: string, key: string) => all(text).find((n) => n.key === key)?.id as string;
const node = (text: string, key: string) => all(text).find((n) => n.key === key) as FlowNode;
const off = (text: string, ...keys: string[]) =>
  apply(text, { kind: 'setDisabled', ids: keys.map((k) => id(text, k)), disabled: true });
const codes = (text: string, key?: string) =>
  validateFlow(docOf(text))
    .findings.filter((f) => !key || f.node === id(text, key))
    .map((f) => f.code);
/** Per host, every `key.port` it left through in a simulated run. */
const run = (text: string, hosts: string[]) => {
  const doc = docOf(text);
  const sim = simulateRun(doc, { inputs: { devices: hosts } });
  const keys = new Map([...buildModel(doc).nodes.values()].map((n) => [n.node.id, n.node.key]));
  const out: string[] = [];
  for (const [n, byPort] of Object.entries(sim.summary?.nodes ?? {}))
    for (const [port, list] of Object.entries(byPort))
      if (list.length) out.push(`${keys.get(n)}.${port}`);
  return { sim, left: out.sort() };
};

describe('the field and its commands', () => {
  it('setDisabled writes disabled: true on several nodes in one edit, and takes it away', () => {
    const text = off(EDGE, 'validate', 'backup-config');
    expect(node(text, 'validate').disabled).toBe(true);
    expect(node(text, 'backup-config').disabled).toBe(true);
    const back = apply(text, {
      kind: 'setDisabled',
      ids: [id(text, 'validate'), id(text, 'backup-config')],
      disabled: false,
    });
    expect(node(back, 'validate').disabled).toBeUndefined();
    expect(back).toBe(EDGE);
  });

  it('updateNode takes it too (the AI update_node op); start and end are refused', () => {
    const text = apply(EDGE, {
      kind: 'updateNode',
      id: id(EDGE, 'validate'),
      patch: { disabled: true },
    });
    expect(node(text, 'validate').disabled).toBe(true);
    try {
      planCommand(EDGE, { kind: 'setDisabled', ids: [id(EDGE, 'start')], disabled: true }, ctx);
      throw new Error('not refused');
    } catch (e) {
      expect(e).toBeInstanceOf(CommandError);
      expect((e as CommandError).code).toBe('bad-type');
    }
  });
});

describe('what runs', () => {
  it('the flow the generator reads has the node out and the path closed over it', () => {
    const text = off(EDGE, 'validate');
    const doc = docOf(text);
    const seen = withoutDisabled(doc);
    expect(seen.nodes.some((n) => n.key === 'validate')).toBe(false);
    const push = seen.nodes.find((n) => n.key === 'push-baseline')?.id;
    const done = seen.nodes.find((n) => n.key === 'done')?.id;
    expect(
      seen.edges?.some(
        (e) => e.from.node === push && e.from.port === 'ok_hosts' && e.to.node === done,
      ),
    ).toBe(true);
    // The flow as written is untouched, and the answer is kept per document.
    expect(doc.nodes.some((n) => n.key === 'validate')).toBe(true);
    expect(withoutDisabled(doc)).toBe(seen);
    const plain = docOf(EDGE);
    expect(withoutDisabled(plain)).toBe(plain);
  });

  it('no play is generated for it, and the others generate as before', () => {
    const text = off(EDGE, 'validate');
    const was = optionA.generate(docOf(EDGE), { source: 'edge-baseline.flow.yaml' });
    const now = optionA.generate(docOf(text), { source: 'edge-baseline.flow.yaml' });
    expect(now.ok).toBe(true);
    expect(was.plays[id(EDGE, 'validate')]).toBeDefined();
    expect(now.plays[id(text, 'validate')]).toBeUndefined();
    expect(Object.keys(now.plays).length).toBe(Object.keys(was.plays).length - 1);
    expect(now.files[0]?.text).not.toContain('Validate');
  });

  it('simulated: the hosts pass through it and reach the end they reached before', () => {
    const before = run(EDGE, ['sw1', 'sw2']);
    const after = run(off(EDGE, 'validate'), ['sw1', 'sw2']);
    expect(after.sim.error).toBeUndefined();
    expect(before.left).toContain('validate.ok_hosts');
    expect(after.left.some((l) => l.startsWith('validate.'))).toBe(false);
    expect(after.left).toContain('push-baseline.ok_hosts');
    expect(after.left.filter((l) => l.startsWith('done.'))).toEqual(
      before.left.filter((l) => l.startsWith('done.')),
    );
  });

  it('a disabled subflow takes its inner steps with it', () => {
    const text = off(OS, 'upgrade-os');
    const now = optionA.generate(docOf(text), { source: 'os-upgrade.flow.yaml' });
    expect(now.ok).toBe(true);
    expect(now.plays[id(text, 'reload')]).toBeUndefined();
    expect(now.files.some((f) => f.level === id(text, 'upgrade-os'))).toBe(false);
  });
});

describe('what validation says', () => {
  it('warnings about a disabled node go; its open fail ports are not open', () => {
    const base = codes(EDGE, 'validate');
    const text = off(EDGE, 'validate');
    expect(codes(text, 'validate')).toEqual([]);
    const openBefore = openFailPorts(buildModel(docOf(EDGE))).map((p) => p.node);
    const openAfter = openFailPorts(buildModel(docOf(text))).map((p) => p.node);
    expect(openAfter).not.toContain(id(text, 'validate'));
    expect(openAfter.length).toBe(openBefore.filter((n) => n !== id(EDGE, 'validate')).length);
    // Nothing new about the node's neighbours either.
    expect(base.every((c) => typeof c === 'string')).toBe(true);
  });

  it('a step that reads a disabled step is told so', () => {
    const text = off(EDGE, 'backup-config');
    const found = validateFlow(docOf(text)).findings.filter((f) => f.code === 'reads-disabled');
    expect(found.map((f) => f.node).sort()).toEqual(
      [id(text, 'push-baseline'), id(text, 'rollback')].sort(),
    );
    expect(found[0]?.severity).toBe('warning');
    expect(found[0]?.message).toContain('is disabled and makes nothing');
  });

  it('a disabled decision with both branches wired ends the path, and says so', () => {
    const text = off(OS, 'upgrade-needed');
    expect(codes(text, 'upgrade-needed')).toEqual(['disabled-ends-path']);
    // A step with one way on does not.
    expect(codes(off(OS, 'backup-config'), 'backup-config')).toEqual([]);
  });

  it('disabled on a start node written by hand is an error', () => {
    const doc = docOf(EDGE);
    (doc.nodes[0] as FlowNode).disabled = true;
    expect(validateFlow(doc).findings.map((f) => f.code)).toContain('disabled-not-allowed');
  });
});

describe('on the canvas', () => {
  it('the node says it is disabled; Find lists the disabled ones', () => {
    const text = off(EDGE, 'validate');
    expect(subLine(node(text, 'validate'))).toBe('Disabled · hosts pass through');
    const q = parseFind('has:disabled');
    expect(
      all(text)
        .filter((n) => matchesFilters(n, q))
        .map((n) => n.key),
    ).toEqual(['validate']);
  });
});

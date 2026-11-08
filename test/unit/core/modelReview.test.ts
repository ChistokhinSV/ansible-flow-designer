// AFD-125, codegen and model group (AFD-142..147): references that renames and new keys must keep,
// what max_fail_percentage counts, and user text in Jinja. Each case is a finding of the 0.74.1
// code review, kept as a regression test.
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { optionA } from '../../../src/core/engine/optionA';
import { jinjaLiteral } from '../../../src/core/engine/util';
import { looksLikeNodes, parseClip } from '../../../src/core/flow/clipboard';
import { type FlowCommand, planCommand } from '../../../src/core/flow/commands';
import { completeIds } from '../../../src/core/flow/completeIds';
import { containsItself, parseFlow } from '../../../src/core/flow/document';
import { createIdFactory } from '../../../src/core/flow/ids';
import { conditionExpr, conditionHasBraces } from '../../../src/core/flow/jinja';
import { buildModel, ROOT } from '../../../src/core/flow/model';
import type { FlowDocument, FlowNode } from '../../../src/core/flow/types';
import { validateFlow } from '../../../src/core/flow/validate';
import { simulateRun } from '../../../src/core/scenario/simulate';
import { readExample, readFixture } from './helpers';

const newId = createIdFactory();
const docOf = (text: string) => parse(text) as FlowDocument;
const run = (text: string, cmd: FlowCommand) => planCommand(text, cmd, { newId });

/** data-across with precheck's output lifted by an explicit `from` (AFD-142). */
const lifted = () =>
  completeIds(
    readFixture('data-across.flow.yaml').replace(
      '  outputs:\n    baseline:\n      type: dict\n  subflow:',
      '  outputs:\n    baseline:\n      type: dict\n      from: capture.baseline\n  subflow:',
    ),
    newId,
  ).text;

function node(doc: FlowDocument, path: string): FlowNode {
  const model = buildModel(doc);
  let level = ROOT;
  let found: FlowNode | undefined;
  for (const key of path.split('/')) {
    found = model.levels.get(level)?.nodes.find((n) => n.key === key);
    if (!found) throw new Error(`no ${path}`);
    level = found.id;
  }
  return found as FlowNode;
}

describe('AFD-143: a new or renamed key does not take over references to an outer node', () => {
  // rollback/restore reads rollback.backup_file: its subflow's input, found around its level.
  const text = () => completeIds(readFixture('data-across.flow.yaml'), newId).text;

  it('a generated key passes the taken one by; the reference keeps reading the subflow input', () => {
    const base = text();
    const rollback = node(docOf(base), 'rollback');
    const r = run(base, { kind: 'addNode', parent: rollback.id, type: 'task', title: 'Rollback' });
    const keys = (node(docOf(r.text), 'rollback').subflow?.nodes ?? []).map((n) => n.key);
    expect(keys).toContain('rollback-2');
    expect(keys).not.toContain('rollback');
    expect(node(docOf(r.text), 'rollback/restore').inputs?.file?.from).toBe('rollback.backup_file');
  });

  it('a key given explicitly, or a rename to it, is refused with the reason', () => {
    const base = text();
    const rollback = node(docOf(base), 'rollback');
    expect(() =>
      run(base, {
        kind: 'addNode',
        parent: rollback.id,
        type: 'task',
        title: 'Again',
        key: 'rollback',
      }),
    ).toThrow(/would take over the references/);
    expect(() =>
      run(base, {
        kind: 'updateNode',
        id: node(docOf(base), 'rollback/wait').id,
        patch: { key: 'rollback' },
      }),
    ).toThrow(/would take over the references/);
    // A key nothing reads around this level is still fine.
    expect(() =>
      run(base, {
        kind: 'updateNode',
        id: node(docOf(base), 'rollback/wait').id,
        patch: { key: 'settle' },
      }),
    ).not.toThrow();
  });
});

describe('AFD-144: max_fail_percentage counts the hosts its own step failed', () => {
  // Both steps' failures bubble to the subflow's failed_hosts, one shared group.
  const FLOW = completeIds(
    [
      'schema_version: 1',
      'flow:',
      '  key: max-fail',
      '  name: Max fail',
      '  version: 1',
      '  inputs:',
      '    devices: {type: host_list, required: true, targets: true}',
      'nodes:',
      '- {key: start, type: start, title: Start}',
      '- key: sub',
      '  type: subflow',
      '  title: Sub',
      '  subflow:',
      '    nodes:',
      '    - {key: s1, type: task, title: S1}',
      '    - key: s2',
      '      type: task',
      '      title: S2',
      '      settings: {max_fail_percentage: 50}',
      '    edges:',
      '    - from: {node: s1, port: ok_hosts}',
      '      to: {node: s2, port: in}',
      '    boundary:',
      '      in: s1',
      '      outputs:',
      '        ok_hosts:',
      '        - {node: s2, port: ok_hosts}',
      '- {key: done, type: end, title: Done}',
      '- {key: stopped, type: end, title: Stopped, outcome: failed}',
      'edges:',
      '- from: {node: start, port: start}',
      '  to: {node: sub, port: in}',
      '- from: {node: sub, port: ok_hosts}',
      '  to: {node: done, port: in}',
      '- from: {node: sub, port: failed_hosts}',
      '  to: {node: stopped, port: in}',
      '',
    ].join('\n'),
    newId,
  ).text;
  const hosts = Array.from({ length: 10 }, (_, i) => `h${i}`);

  it('4 of 10 fail at S1; S2 fails none, so its 50% limit does not stop the 6 healthy hosts', () => {
    const doc = docOf(FLOW);
    const sim = simulateRun(doc, {
      inputs: { devices: hosts },
      force: { 'sub/s1': { failed: hosts.slice(0, 4) } },
    });
    expect(sim.error).toBeUndefined();
    // Only the hosts S1 failed end failed; before AFD-144 the limit stopped the other 6 at S2.
    expect(Object.keys(sim.summary?.outcome ?? {}).sort()).toEqual(hosts.slice(0, 4));
    const sub = node(doc, 'sub').id;
    expect(sim.summary?.nodes?.[sub]?.ok_hosts?.sort()).toEqual(hosts.slice(4));
  });

  it("the generated limit counts S2's own group, not the subflow's failed_hosts", () => {
    const files = optionA.generate(docOf(FLOW), { source: 'max-fail.flow.yaml' }).files;
    const text = files.map((f) => f.text).join('\n');
    const check = text.split('\n').find((l) => l.includes('* 100 > 50 *')) ?? '';
    expect(check).toContain('s2_failed_here');
    expect(check).not.toContain('failed_hosts');
    expect(text).toContain('[s2] count the failure');
  });
});

describe('AFD-145: titles stay literal where Ansible renders Jinja', () => {
  it('jinjaLiteral turns each opening delimiter into a string expression of itself', () => {
    expect(jinjaLiteral('Install {{ item }} {% x %} {# y')).toBe(
      "Install {{ '{{' }} item }} {{ '{%' }} x %} {{ '{#' }} y",
    );
    expect(jinjaLiteral('no braces at all')).toBe('no braces at all');
  });

  it('a stub, an end and a decision message carry the escaped title', () => {
    const doc = docOf(readExample('edge-baseline.flow.yaml'));
    const step = doc.nodes.find((n) => n.key === 'backup-config') as FlowNode;
    step.title = 'Install {{ item }}';
    delete step.intent; // the stub prints the intent when there is one
    const text = optionA
      .generate(doc, { source: 'edge-baseline.flow.yaml' })
      .files.map((f) => f.text)
      .join('\n');
    expect(text).toContain("TODO: Install {{ '{{' }} item }}");
    expect(text).not.toMatch(/TODO: Install \{\{ item/);
    // Play and task names are rendered too: ansible-core 2.22 stops the whole run on an
    // undefined variable in one ("Error processing keyword 'name'").
    expect(text).toContain("[backup-config] Install {{ '{{' }} item }}");
    expect(text).not.toMatch(/\[backup-config\] Install \{\{ item/);
  });
});

describe('AFD-146: decision conditions with braces', () => {
  it('a whole {{ }} wrapper comes off; spaces inside strings stay; breaks become spaces', () => {
    expect(conditionExpr('{{ x == 1 }}')).toBe('x == 1');
    expect(conditionExpr('x == "a  b"')).toBe('x == "a  b"');
    expect(conditionExpr('a\nand b')).toBe('a and b');
    expect(conditionHasBraces('{{ x == 1 }}')).toBe(false);
    expect(conditionHasBraces('{{ x }} == 1')).toBe(true);
  });

  it('braces inside the condition are an error that says how to write it', () => {
    const doc = docOf(readExample('os-upgrade.flow.yaml'));
    const decision = doc.nodes.find((n) => n.key === 'upgrade-needed') as FlowNode;
    const codes = () => validateFlow(doc).findings.map((f) => f.code);
    decision.condition = '{{ ansible_net_version }} is version(target_version, "<")';
    expect(codes()).toContain('condition-braces');
    decision.condition = "{{ ansible_net_version is version(target_version, '<') }}";
    expect(codes()).not.toContain('condition-braces');
    const text = optionA
      .generate(doc, { source: 'os-upgrade.flow.yaml' })
      .files.map((f) => f.text)
      .join('\n');
    expect(text).toContain("not (ansible_net_version is version(target_version, '<'))");
  });
});

describe('AFD-147: an alias inside what it names is refused, not walked forever', () => {
  const SELF = [
    'schema_version: 1',
    'flow: {key: loop, name: Loop, version: 1}',
    'nodes:',
    '- key: outer',
    '  type: subflow',
    '  title: Outer',
    '  subflow: &s',
    '    nodes:',
    '    - {key: inner, type: subflow, title: Inner, subflow: *s}',
    '',
  ].join('\n');

  it('a flow file reads as an error, so no walker sees the cycle', () => {
    const parsed = parseFlow(SELF);
    expect(parsed.doc).toBeUndefined();
    expect(parsed.errors[0]?.message).toMatch(/alias here names something that contains it/);
    expect(containsItself({ a: [1, { b: 2 }] })).toBe(false);
  });

  it('a clipboard snippet is not taken as nodes, and the check does not throw', () => {
    const clip = ['nodes:', '- &n {key: a, type: task, title: A, subflow: {nodes: [*n]}}', ''].join(
      '\n',
    );
    expect(() => looksLikeNodes(clip)).not.toThrow();
    expect(looksLikeNodes(clip)).toBe(false);
    expect(parseClip(clip)).toMatch(/alias here names something that contains it/);
  });
});

describe('AFD-142: renames follow a subflow output lifted from an inner step', () => {
  it('renaming the inner step rewrites the lift', () => {
    const text = lifted();
    expect(node(docOf(text), 'precheck').outputs?.baseline?.from).toBe('capture.baseline');
    const r = run(text, {
      kind: 'updateNode',
      id: node(docOf(text), 'precheck/capture').id,
      patch: { key: 'snapshot' },
    });
    expect(node(docOf(r.text), 'precheck').outputs?.baseline?.from).toBe('snapshot.baseline');
  });

  it("renaming the inner step's output rewrites the lift", () => {
    const text = lifted();
    const capture = node(docOf(text), 'precheck/capture');
    const r = run(text, {
      kind: 'setContractField',
      target: capture.id,
      side: 'outputs',
      name: 'baseline',
      field: { type: 'dict', from: 'impl.register' },
      rename: 'snap',
    });
    expect(node(docOf(r.text), 'precheck').outputs?.baseline?.from).toBe('capture.snap');
  });
});

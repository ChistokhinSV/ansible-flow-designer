// M6 (AFD-9): design vs code. The scan is real probe output for test/fixtures/drift (ansible-core
// 2.19, captured with the probe's compile and roles methods); the flow mirrors mockup 04.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { computeDrift } from '../../../src/core/drift/drift';
import { argumentSpecsText, roleName, roleStub } from '../../../src/core/drift/stub';
import type { CodeScan, DriftItem } from '../../../src/core/drift/types';
import { optionA } from '../../../src/core/engine/optionA';
import { type FlowCommand, planCommand } from '../../../src/core/flow/commands';
import { createIdFactory } from '../../../src/core/flow/ids';
import { buildModel } from '../../../src/core/flow/model';
import { createSchemaValidator } from '../../../src/core/flow/schema';
import type { FlowDocument, FlowNode } from '../../../src/core/flow/types';
import { validateFlow } from '../../../src/core/flow/validate';
import { applyEdits } from '../../../src/core/yaml';

const DIR = join(__dirname, '../../fixtures/drift');
const FLOW = readFileSync(join(DIR, 'flows/edge-drift/edge-drift.flow.yaml'), 'utf8');
const raw = JSON.parse(readFileSync(join(DIR, 'scan.json'), 'utf8')) as Omit<
  CodeScan,
  'at' | 'environment'
>;
const scanOf = (patch: Partial<CodeScan> = {}): CodeScan => ({
  at: '2026-10-29T12:00:00Z',
  environment: 'docker: ps-probe-env:2.19',
  ...structuredClone(raw),
  ...patch,
});
const docOf = (text: string) => parse(text) as FlowDocument;
const nodeOf = (text: string, key: string): FlowNode => {
  for (const { node } of buildModel(docOf(text)).nodes.values()) if (node.key === key) return node;
  throw new Error(key);
};
const byId = (items: DriftItem[], node: string, id: string) =>
  items.find((i) => i.node === nodeOf(FLOW, node).id && i.id === id);
const schema = createSchemaValidator();
const ctx = { newId: createIdFactory() };
const apply = (text: string, cmd: FlowCommand) => {
  const r = planCommand(text, cmd, ctx);
  expect(applyEdits(text, r.edits)).toBe(r.text);
  expect(schema(docOf(r.text))).toEqual([]);
  return r.text;
};

describe('fixture', () => {
  it('generated code is what the engine produces (the scan compiled it)', () => {
    const result = optionA.generate(docOf(FLOW), { source: 'edge-drift.flow.yaml' });
    for (const f of result.files)
      expect(readFileSync(join(DIR, 'flows/edge-drift/generated', f.name), 'utf8'), f.name).toBe(
        f.text,
      );
  });
});

describe('computeDrift (D-29, mockup 04)', () => {
  const report = computeDrift(docOf(FLOW), scanOf());

  it('matches every generated play to its node by ID', () => {
    expect(report.matchable).toBe(7);
    expect(report.matched).toBe(7);
    expect(report.nodes[nodeOf(FLOW, 'validate').id]?.play?.path).toBe(
      'flows/edge-drift/generated/edge-drift.yml',
    );
  });

  it('shows what each node runs, without Ansible’s own spec check', () => {
    const at = (key: string) => report.nodes[nodeOf(FLOW, key).id];
    expect(at('validate')).toMatchObject({ artifact: 'role: netops_validate', dynamic: 0 });
    expect(at('validate')?.tasks.map((t) => t.action)).toEqual(['ansible.builtin.command']);
    expect(at('push-baseline')?.artifact).toBe('role: push_baseline · 2 steps');
    expect(at('push-baseline')?.tasks).toHaveLength(3);
    expect(at('precheck')).toMatchObject({ artifact: 'playbook: precheck.yml' });
    expect(at('precheck')?.tasks.map((t) => t.action)).toEqual([
      'ansible.builtin.ping',
      'ansible.builtin.debug',
    ]);
    expect(at('rollback')?.artifact).toBe('not bound');
  });

  it('contract mismatch: outputs differ, both ways', () => {
    const item = byId(report.items, 'validate', 'output:validation_result');
    expect(item).toMatchObject({
      kind: 'contract_mismatch',
      title: 'Validate',
      label: 'outputs differ',
      detail: 'Design expects `validation_result`, code registers `diff_report`.',
    });
    expect(item?.actions.map((a) => a.action)).toEqual([
      {
        kind: 'renameOutput',
        node: nodeOf(FLOW, 'validate').id,
        from: 'validation_result',
        to: 'diff_report',
      },
      { kind: 'openCode', path: 'roles/netops_validate/tasks/main.yml', line: 2 },
      { kind: 'ignore', node: nodeOf(FLOW, 'validate').id, item: 'output:validation_result' },
    ]);
  });

  it('contract mismatch: a required role argument the node does not pass', () => {
    const item = byId(report.items, 'validate', 'input-required:site');
    expect(item?.actions[0]?.action).toEqual({
      kind: 'addInput',
      node: nodeOf(FLOW, 'validate').id,
      name: 'site',
      field: { type: 'string', required: true, from: 'flow.site' },
    });
    // `backup` is an argument of the role: no item.
    expect(byId(report.items, 'validate', 'input-unknown:backup')).toBeUndefined();
  });

  it('code without design: a role task file the subflow does not cover', () => {
    const item = byId(report.items, 'push-baseline', 'task-file:wait_for_convergence');
    expect(item).toMatchObject({
      kind: 'code_without_design',
      label: 'task not in design',
      detail: '`wait_for_convergence` exists in the role but not in the subflow.',
    });
    expect(item?.actions[0]?.label).toBe('Add to Subflow');
    for (const covered of ['ntp', 'aaa', 'main'])
      expect(byId(report.items, 'push-baseline', `task-file:${covered}`)).toBeUndefined();
  });

  it('design without code: the unbound rollback, and a role without specs', () => {
    expect(byId(report.items, 'rollback', 'unbound:01JCR6N0000000000000000007')).toMatchObject({
      kind: 'design_without_code',
      label: 'no code yet',
      detail: 'Designed and wired to a fail port, but nothing is bound.',
    });
    expect(
      byId(report.items, 'rollback', 'unbound:01JCR6N0000000000000000007')?.actions.map(
        (a) => a.label,
      ),
    ).toEqual(['Generate Stub', 'Bind Role', 'Accept with Reason…']);
    expect(byId(report.items, 'backup-config', 'no-spec:main')?.actions[0]?.action.kind).toBe(
      'writeSpecs',
    );
    // The role sets the output the node declares.
    expect(byId(report.items, 'backup-config', 'output:backup_ref')).toBeUndefined();
  });

  it('ignored items stay listed, with the reason and a way back', () => {
    const doc = docOf(FLOW);
    const sub = nodeOf(FLOW, 'push-baseline').id;
    doc.decisions = [
      {
        node: sub,
        kind: 'drift_ignored',
        item: 'task-file:wait_for_convergence',
        reason: 'Runs from the role main',
        by: 'Jane Example',
      },
    ];
    const item = computeDrift(doc, scanOf()).items.find(
      (i) => i.id === 'task-file:wait_for_convergence',
    );
    expect(item?.ignored).toEqual({ reason: 'Runs from the role main', by: 'Jane Example' });
    expect(item?.actions.map((a) => a.action.kind)).toEqual(['unignore']);
  });

  it('plays for missing nodes, nodes without plays, and missing generated code', () => {
    const scan = scanOf();
    const validate = nodeOf(FLOW, 'validate').id;
    for (const p of scan.generated.plays) p.tags = p.tags.filter((t) => t !== `node_${validate}`);
    scan.generated.plays.push({
      name: '[gone] Old step',
      hosts: 'all',
      tags: ['node_01JCR6N0000000000000000099'],
      origin: { path: 'x.yml', line: 3 },
      tasks: [],
    });
    const r = computeDrift(docOf(FLOW), scan);
    expect(r.matched).toBe(6);
    expect(r.items.find((i) => i.id === `unmatched:${validate}`)?.label).toBe(
      'not in generated code',
    );
    expect(
      r.items.find((i) => i.kind === 'code_without_design' && i.label === 'play without a node')
        ?.detail,
    ).toContain('node_01JCR6N0000000000000000099');
    const none = computeDrift(
      docOf(FLOW),
      scanOf({ generated: { path: 'g.yml', error: 'not found', plays: [] } }),
    );
    expect(none.items.map((i) => i.label)).toContain('no generated code');
    expect(none.items.some((i) => i.label === 'not in generated code')).toBe(false);
  });

  it('missing roles and playbooks, and module results the module does not return', () => {
    const doc = docOf(FLOW);
    const backup = doc.nodes.find((n) => n.key === 'backup-config') as FlowNode;
    backup.impl = { kind: 'module', ref: 'cisco.ios.ios_config' };
    backup.outputs = { backup_ref: { type: 'string', from: 'impl.register.backup_file' } };
    const validate = doc.nodes.find((n) => n.key === 'validate') as FlowNode;
    validate.impl = { kind: 'role', ref: 'netops_absent' };
    const precheck = doc.nodes.find((n) => n.key === 'precheck') as FlowNode;
    precheck.impl = { kind: 'playbook', ref: 'playbooks/absent.yml' };
    // As the host scans: every bound role and playbook is compiled, missing ones report it.
    const scan = scanOf({ moduleReturns: { 'cisco.ios.ios_config': ['backup_path', 'commands'] } });
    scan.roles.push({
      name: 'netops_absent',
      tasks_from: null,
      error: "AnsibleError: the role 'netops_absent' was not found",
      tasks: [],
    });
    scan.playbooks.push({ path: 'playbooks/absent.yml', error: 'not found', plays: [] });
    const r = computeDrift(doc, scan);
    const at = (key: string) =>
      r.items.filter((i) => i.node === doc.nodes.find((n) => n.key === key)?.id);
    expect(at('backup-config')[0]).toMatchObject({
      label: 'outputs differ',
      detail:
        'Design reads `backup_file` from the cisco.ios.ios_config result, which returns `backup_path`, `commands`.',
    });
    expect(at('backup-config')[0]?.actions[0]?.action).toMatchObject({
      kind: 'setOutputFrom',
      from: 'impl.register.backup_path',
    });
    expect(at('validate')[0]).toMatchObject({ label: 'role missing' });
    expect(at('validate')[0]?.actions[0]?.action).toMatchObject({
      kind: 'generateStub',
      role: 'netops_absent',
    });
    expect(at('precheck')[0]).toMatchObject({ label: 'playbook missing' });
    // Bound after the scan: compile it before judging it.
    const later = docOf(FLOW);
    const pre = later.nodes.find((n) => n.key === 'precheck') as FlowNode;
    pre.impl = { kind: 'playbook', ref: 'playbooks/other.yml' };
    expect(computeDrift(later, scanOf()).items.find((i) => i.node === pre.id)).toMatchObject({
      label: 'not scanned yet',
    });
  });
});

describe('code from the design', () => {
  it('a role stub with argument specs from the contract', () => {
    const node: FlowNode = {
      ...nodeOf(FLOW, 'rollback'),
      inputs: {
        backup: { type: 'string', required: true, from: 'backup-config.backup_ref' },
        retries: { type: 'integer', default: 2 },
      },
      outputs: { restored: { type: 'boolean' } },
    };
    const files = roleStub(
      node,
      { key: 'edge-drift', name: 'Edge baseline (drift)' },
      roleName(node.key),
    );
    expect(files.map((f) => f.path)).toEqual([
      'roles/rollback/tasks/main.yml',
      'roles/rollback/meta/argument_specs.yml',
    ]);
    const tasks = parse(files[0]?.text ?? '') as Record<string, unknown>[];
    expect(tasks[0]?.['ansible.builtin.debug']).toEqual({
      msg: 'TODO: Restore the backed-up configuration',
    });
    expect(tasks[1]?.['ansible.builtin.set_fact']).toEqual({ restored: false });
    expect(parse(argumentSpecsText(node))).toEqual({
      argument_specs: {
        main: {
          short_description: 'Rollback',
          description: 'Restore the backed-up configuration',
          options: {
            backup: {
              type: 'str',
              required: true,
              description: 'From backup-config.backup_ref in the flow',
            },
            retries: { type: 'int', default: 2, description: 'Flow input contract: retries' },
          },
        },
      },
    });
    expect(roleName('push-baseline')).toBe('push_baseline');
  });
});

describe('drift commands', () => {
  it('ignoreDrift records a reasoned decision; clearDriftIgnore removes it', () => {
    const sub = nodeOf(FLOW, 'push-baseline').id;
    const ignored = apply(FLOW, {
      kind: 'ignoreDrift',
      node: sub,
      item: 'task-file:wait_for_convergence',
      reason: 'Runs from main',
      by: 'Jane Example',
    });
    expect(docOf(ignored).decisions).toEqual([
      {
        node: sub,
        kind: 'drift_ignored',
        item: 'task-file:wait_for_convergence',
        reason: 'Runs from main',
        by: 'Jane Example',
      },
    ]);
    expect(
      validateFlow(docOf(ignored)).findings.filter((f) => f.code.includes('decision')),
    ).toEqual([]);
    expect(() =>
      planCommand(FLOW, { kind: 'ignoreDrift', node: sub, item: 'x', reason: ' ' }, ctx),
    ).toThrow(/Say why/);
    expect(
      apply(ignored, {
        kind: 'clearDriftIgnore',
        node: sub,
        item: 'task-file:wait_for_convergence',
      }),
    ).toBe(FLOW);
  });

  it('renaming an output rewrites the downstream references in the same edit', () => {
    const backup = nodeOf(FLOW, 'backup-config').id;
    const text = apply(FLOW, {
      kind: 'setContractField',
      target: backup,
      side: 'outputs',
      name: 'backup_ref',
      rename: 'backup_path',
      field: { type: 'string' },
    });
    expect(nodeOf(text, 'validate').inputs?.backup?.from).toBe('backup-config.backup_path');
  });

  it('addNode can bind the new step (Add to Subflow)', () => {
    const sub = nodeOf(FLOW, 'push-baseline').id;
    const r = planCommand(
      FLOW,
      {
        kind: 'addNode',
        parent: sub,
        type: 'task',
        title: 'Wait for convergence',
        impl: {
          kind: 'role',
          ref: 'push_baseline',
          params: { tasks_from: 'wait_for_convergence' },
        },
        position: { x: 40, y: 400 },
      },
      ctx,
    );
    expect(schema(docOf(r.text))).toEqual([]);
    const added = buildModel(docOf(r.text)).nodes.get(r.created ?? '');
    expect(added?.level).toBe(sub);
    expect(added?.node.impl).toEqual({
      kind: 'role',
      ref: 'push_baseline',
      params: { tasks_from: 'wait_for_convergence' },
    });
    const after = computeDrift(docOf(r.text), scanOf());
    expect(after.items.find((i) => i.id === 'task-file:wait_for_convergence')).toBeUndefined();
  });
});

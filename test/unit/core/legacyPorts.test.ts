// AFD-54: the undo and cancelled ports were never built. Nothing offers them, a node that has one
// warns, the upgrade removes them with their wires, and Rollback wires explicit undo steps instead.
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { optionA } from '../../../src/core/engine/optionA';
import { type FlowCommand, planCommand } from '../../../src/core/flow/commands';
import { createIdFactory } from '../../../src/core/flow/ids';
import { upgradeNotes } from '../../../src/core/flow/migrate';
import { buildModel } from '../../../src/core/flow/model';
import { offeredPortNames } from '../../../src/core/flow/ports';
import type { FlowDocument } from '../../../src/core/flow/types';
import { validateFlow } from '../../../src/core/flow/validate';
import { readExample } from './helpers';

const ctx = { newId: createIdFactory() };
const OS = readExample('os-upgrade.flow.yaml');
const plan = (text: string, cmd: FlowCommand) => planCommand(text, cmd, ctx);
const doc = (text: string) => parse(text) as FlowDocument;
const node = (text: string, key: string) =>
  [...buildModel(doc(text)).nodes.values()].find((e) => e.node.key === key)?.node;
const id = (text: string, key: string) => node(text, key)?.id as string;

describe('undo and cancelled ports (AFD-54)', () => {
  it('a new node never gets one, from Quick Add or the AI tools (AFD-71)', () => {
    const r = plan(OS, {
      kind: 'addNode',
      type: 'task',
      title: 'Check NTP',
      ports: ['undo', 'cancelled', 'always'],
    });
    expect(node(r.text, 'check-ntp')?.ports).toEqual(['always']);
    expect(offeredPortNames('task')).toEqual(['unreachable', 'unchanged', 'always', 'timeout']);
  });

  it('the upgrade removes them and their wires, keeps the undo binding, and says so', () => {
    // Nothing enables them any more; a file written before does.
    expect(() =>
      plan(OS, {
        kind: 'setPortEnabled',
        node: id(OS, 'post-checks'),
        port: 'cancelled',
        enabled: true,
      }),
    ).toThrow('never built');
    const wire = [
      '- id: 01JBZZZZZZZZZZZZZZZZZZZZZZ',
      '  from:',
      `    node: ${id(OS, 'post-checks')}`,
      '    port: cancelled',
      '  to:',
      `    node: ${id(OS, 'notify-on-call')}`,
      '    port: in',
    ].join('\n');
    const withWire = OS.replace(
      '  key: post-checks\n',
      '  key: post-checks\n  ports:\n  - cancelled\n',
    ).replace('\nedges:\n', `\nedges:\n${wire}\n`);
    expect(node(withWire, 'post-checks')?.ports).toEqual(['cancelled']);
    expect(upgradeNotes(doc(withWire))).toContain(
      'the undo and cancelled ports go (4 nodes, 1 wire): they were never built; Rollback wires explicit undo steps, and undo bindings stay',
    );
    const up = plan(withWire, { kind: 'upgradeFormat' }).text;
    for (const n of buildModel(doc(up)).nodes.values())
      expect(n.node.ports ?? []).not.toEqual(expect.arrayContaining(['undo']));
    expect(up).not.toMatch(/port: (undo|cancelled)\b/);
    expect(node(up, 'upgrade-os')?.ports).toEqual(['unreachable']);
    expect(node(up, 'upgrade-os')?.undo).toMatchObject({ kind: 'role', ref: 'netops.os_upgrade' });
    expect(validateFlow(doc(up)).findings.map((f) => f.code)).not.toContain('legacy-port');
  });

  it('Rollback wires an undo step per completed step, newest first, bound where the step says how', () => {
    // Without the level's Rollback, the pattern builds one.
    const bare = plan(OS, { kind: 'deleteNodes', ids: [id(OS, 'rollback')] }).text;
    const r = plan(bare, {
      kind: 'applyPattern',
      pattern: 'rollback',
      from: { node: id(bare, 'upgrade-os'), port: 'failed_hosts' },
    });
    const rollback = doc(r.text).nodes.find((n) => n.id === r.created);
    expect(rollback).toMatchObject({ type: 'subflow', title: 'Rollback' });
    expect(rollback?.purpose).toBeUndefined();
    expect(rollback?.handler).toBe('rollback'); // format 1 writes its own name
    const steps = rollback?.subflow?.nodes ?? [];
    expect(steps.map((s) => s.title)).toEqual([
      'Undo Upgrade OS',
      'Undo Drain traffic',
      'Undo Backup config',
      'Undo Pre-checks',
    ]);
    expect(steps[0]).toMatchObject({
      status: 'implemented',
      impl: { kind: 'role', ref: 'netops.os_upgrade', params: { tasks_from: 'boot_previous' } },
    });
    expect(steps[1]?.impl).toBeUndefined();
    const chain = (rollback?.subflow?.edges ?? []).map((e) => [e.from.node, e.to.node]);
    expect(chain).toEqual(steps.slice(1).map((s, i) => [steps[i]?.id, s.id]));
    expect(rollback?.subflow?.boundary).toEqual({
      in: steps[0]?.id,
      outputs: { ok_hosts: [{ node: steps[3]?.id, port: 'ok_hosts' }] },
    });
    // Its hosts end as failed; the code generates.
    const out = doc(r.text).edges.find((e) => e.from.node === r.created);
    expect(node(r.text, 'failed')?.id).toBe(out?.to.node);
    expect(optionA.generate(doc(r.text), { source: 'x' }).ok).toBe(true);
    // The next failure point reuses it.
    const again = plan(r.text, {
      kind: 'applyPattern',
      pattern: 'rollback',
      from: { node: id(r.text, 'post-checks'), port: 'failed_hosts' },
    });
    expect(doc(again.text).nodes).toHaveLength(doc(r.text).nodes.length);
  });
});

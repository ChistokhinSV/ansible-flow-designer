// AFD-342: a flow input as the launch form of Ansible Flow Server explains it: how a run gives it,
// its default, the steps that read it, and what it wins over (a same-name step input, the
// repository's definitions); and the repository's findings a host adds in one call.

import { describe, expect, it } from 'vitest';
import { buildModel } from '../../../src/core/flow/model';
import { flowInputUse, flowInputUses, withRepoFindings } from '../../../src/core/flow/origin';
import type { Edge, FlowDocument, FlowNode } from '../../../src/core/flow/types';
import { validateFlow } from '../../../src/core/flow/validate';
import { memoryFs } from '../../../src/core/inventory/memoryFs';
import { buildVarIndex } from '../../../src/core/inventory/varIndex';

const REPO: Record<string, string> = {
  'ansible.cfg': '[defaults]\ninventory = inventory/hosts.yml\n',
  'inventory/hosts.yml': 'all:\n  children:\n    edge:\n      hosts:\n        sw-01:\n',
  'inventory/group_vars/all.yml': 'ntp_server: 192.0.2.3\nsyslog_host: 198.51.100.5\n',
  'inventory/group_vars/edge.yml': 'ntp_server: 192.0.2.4\napi_password: s3cr3t-value\n',
};
const index = () => buildVarIndex(memoryFs(REPO), { inventory: '' });

let seq = 0;
const id = () => `01USE0${String(++seq).padStart(20, '0')}`;
const step = (key: string, rest: Partial<FlowNode> = {}): FlowNode =>
  ({ id: id(), key, type: 'task', title: key.replace('-', ' '), ...rest }) as FlowNode;

function flow(
  steps: FlowNode[],
  inputs: NonNullable<FlowDocument['flow']['inputs']>,
): FlowDocument {
  const start = { id: id(), key: 'start', type: 'start', title: 'Start' } as FlowNode;
  const done = {
    id: id(),
    key: 'done',
    type: 'end',
    title: 'Done',
    outcome: 'success',
  } as FlowNode;
  const all = [start, ...steps, done];
  const edges = all.slice(1).map((n, i) => ({
    id: id(),
    from: { node: (all[i] as FlowNode).id, port: 'ok_hosts' },
    to: { node: n.id, port: 'in' },
  })) as Edge[];
  return {
    schema_version: 2,
    flow: { id: id(), key: 'use', name: 'Use', version: 1, inputs },
    nodes: all,
    edges,
  } as FlowDocument;
}

describe('a flow input on the launch form (AFD-342)', () => {
  const setNtp = step('set-ntp', {
    inputs: { server: { type: 'string', from: 'flow.ntp_server' } },
    impl: { kind: 'module', ref: 'ansible.builtin.debug', params: { msg: '{{ server }}' } },
  });
  const direct = step('log-it', {
    impl: { kind: 'module', ref: 'ansible.builtin.debug', params: { msg: '{{ ntp_server }}' } },
  });
  const shadow = step('wait', {
    inputs: { ntp_server: { type: 'string', default: '203.0.113.9' } },
    impl: { kind: 'module', ref: 'ansible.builtin.debug', params: { msg: '{{ ntp_server }}' } },
  });
  const doc = flow([setNtp, direct, shadow], {
    ntp_server: { type: 'string', default: '192.0.2.1', description: 'NTP server' },
    unused: { type: 'string', required: true },
    admin_password: { type: 'string', default: 'hunter2-hunter2' },
    devices: { type: 'host_list', required: true, targets: true },
  });

  it('says who reads it (through an input or directly), its default and what it wins over', async () => {
    const model = buildModel(doc);
    const use = flowInputUse(model, 'ntp_server', { index: await index() });
    expect(use.asked).toBe('asked when the run starts');
    expect(use.default).toBe('192.0.2.1');
    expect(use.readBy).toEqual([
      { node: setNtp.id, key: 'set-ntp', title: 'set ntp', input: 'server' },
      { node: direct.id, key: 'log-it', title: 'log it' },
    ]);
    // An extra var beats a same-name play var and every repository definition.
    expect(use.overrides.map((o) => o.label)).toEqual([
      'the default of input ntp_server of "wait"',
      'group_vars of edge',
      'group_vars of all',
    ]);
    expect(use.overrides[1]).toMatchObject({ file: 'inventory/group_vars/edge.yml', line: 0 });
    expect(use.text).toBe(
      'Read by set ntp (as server) and log it; default 192.0.2.1; wins over the default of input ntp_server of "wait", group_vars of edge (inventory/group_vars/edge.yml:1), group_vars of all (inventory/group_vars/all.yml:1).',
    );
  });

  it('without the repository: only the flow; nobody reading it is said', () => {
    const model = buildModel(doc);
    const use = flowInputUse(model, 'ntp_server');
    expect(use.overrides.map((o) => o.file)).toEqual([undefined]);
    const unused = flowInputUse(model, 'unused');
    expect(unused).toMatchObject({ asked: 'asked when the run starts, required', readBy: [] });
    // AFS-189: a required one says that a run gives it all the same.
    expect(unused.text).toBe('No step reads it, though a run must give it.');
    // The targets input is what the run starts on, read by a step or not.
    expect(flowInputUse(model, 'devices')).toMatchObject({
      asked: 'the hosts the run starts on',
      text: 'The hosts the run starts on.',
    });
  });

  it('names every step that reads it: a launch form cannot open "and 1 more" (AFS-189)', () => {
    const readers = ['a', 'b', 'c', 'd'].map((k) =>
      step(k, {
        impl: { kind: 'module', ref: 'ansible.builtin.debug', params: { msg: '{{ site }}' } },
      }),
    );
    const use = flowInputUse(buildModel(flow(readers, { site: { type: 'string' } })), 'site');
    expect(use.text).toBe('Read by a, b, c and d.');
  });

  it('never gives the default of a secret one, nor a repository value', async () => {
    const all = flowInputUses(buildModel(doc), { index: await index() });
    expect(Object.keys(all)).toEqual(['ntp_server', 'unused', 'admin_password', 'devices']);
    expect(all.admin_password).toMatchObject({ secret: true });
    expect(all.admin_password?.default).toBeUndefined();
    expect(JSON.stringify(all)).not.toContain('hunter2');
    expect(JSON.stringify(all)).not.toContain('192.0.2.4');
  });

  it('a host adds the repository findings in one call; without an index, nothing changes', async () => {
    const reader = step('reader', {
      inputs: { syslog_host: { type: 'string', default: '203.0.113.1' } },
      impl: { kind: 'module', ref: 'ansible.builtin.debug', params: { msg: '{{ ntp_server }}' } },
    });
    const { model, findings } = validateFlow(flow([reader], {}));
    expect(withRepoFindings(findings, model, undefined)).toEqual(findings);
    const merged = withRepoFindings(findings, model, await index());
    expect(merged.find((f) => f.subject === 'ntp_server')?.severity).toBe('info');
    expect(merged.some((f) => f.code === 'input-hides-inventory')).toBe(true);
  });
});

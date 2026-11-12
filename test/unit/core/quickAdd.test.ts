// AFD-232: what Quick Add lists under its Title field, and in which order.
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { buildModel } from '../../../src/core/flow/model';
import type { FlowDocument, NodeType } from '../../../src/core/flow/types';
import { suggestSteps, titleFor, usedBindings } from '../../../src/core/view/quickAdd';
import { readExample } from './helpers';

const types: { type: NodeType; label: string }[] = [
  { type: 'task', label: 'Task' },
  { type: 'subflow', label: 'Subflow' },
  { type: 'decision', label: 'Decision' },
];
const modules = [
  { fqcn: 'cisco.ios.ios_config', short_description: 'Manage IOS configuration', dimmed: false },
  { fqcn: 'junipernetworks.junos.junos_config', short_description: 'Junos', dimmed: true },
];
const base = { type: 'task' as NodeType, types, modules: [], roles: [], used: [] };

describe('Quick Add suggestions (AFD-232)', () => {
  it('nothing typed: what the flow already runs, and only for a task', () => {
    const used = [{ kind: 'role' as const, ref: 'netops.backup' }];
    expect(suggestSteps({ ...base, query: '', used })).toEqual([
      {
        kind: 'role',
        ref: 'netops.backup',
        label: 'netops.backup',
        hint: 'role, used in this flow',
      },
    ]);
    expect(suggestSteps({ ...base, query: '', used, type: 'decision' })).toEqual([]);
  });

  it('a step type by the start of its name, never the one already picked', () => {
    expect(suggestSteps({ ...base, query: 'dec' }).map((s) => s.label)).toEqual(['Decision']);
    expect(suggestSteps({ ...base, query: 'ta' })).toEqual([]);
  });

  it('types, then what the flow uses, modules (not the dimmed ones), roles; each once', () => {
    const found = suggestSteps({
      ...base,
      query: 'config',
      modules,
      roles: ['netops.push_config', 'netops.backup'],
      used: [{ kind: 'module', ref: 'cisco.ios.ios_config' }],
    });
    expect(found.map((s) => `${s.kind}:${s.label}`)).toEqual([
      'module:cisco.ios.ios_config',
      'role:netops.push_config',
    ]);
    expect(found[0]?.hint).toBe('module, used in this flow');
  });

  it('another type picked: step types only', () => {
    const found = suggestSteps({ ...base, type: 'decision', query: 's', modules });
    expect(found.map((s) => s.label)).toEqual(['Subflow']);
  });

  it('a title from a module or role name', () => {
    expect(titleFor('cisco.ios.ios_config')).toBe('Ios config');
    expect(titleFor('netops.push-baseline')).toBe('Push baseline');
  });

  it('the bindings of a flow, the latest step first, each once', () => {
    const doc = parse(readExample('edge-baseline.flow.yaml')) as FlowDocument;
    const used = usedBindings(buildModel(doc));
    expect(new Set(used.map((u) => `${u.kind}:${u.ref}`)).size).toBe(used.length);
    for (const u of used) expect(['module', 'role']).toContain(u.kind);
  });
});

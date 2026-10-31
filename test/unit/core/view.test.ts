// AFD-34: the model built once per document, and the view rules moved out of components.
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import type { DriftItem, NodeCode } from '../../../src/core/drift/types';
import { buildModel, modelOf, modelStats } from '../../../src/core/flow/model';
import type { FlowDocument, FlowNode } from '../../../src/core/flow/types';
import type { RunSummary } from '../../../src/core/run/events';
import { codeState } from '../../../src/core/view/codeState';
import {
  EXECUTION_SETTINGS,
  settingProblem,
  settingText,
  settingValue,
} from '../../../src/core/view/settings';
import { readExample } from './helpers';

const doc = () => parse(readExample('os-upgrade.flow.yaml')) as FlowDocument;

describe('modelOf', () => {
  it('builds a document’s model once; a new document gets its own', () => {
    const a = doc();
    const before = modelStats.builds;
    const m = modelOf(a);
    expect(modelOf(a)).toBe(m);
    expect(modelStats.builds - before).toBe(1);
    const b = doc();
    expect(modelOf(b)).not.toBe(m);
    // buildModel never caches: commands and the validator build from what they edit.
    expect(buildModel(a)).not.toBe(m);
  });
});

describe('code state on a node (Code mode)', () => {
  const task = { id: 'n', key: 'n', type: 'task', title: 'N' } as FlowNode;
  const bound = { ...task, impl: { kind: 'module', ref: 'ansible.builtin.ping' } } as FlowNode;
  const code = (matched: boolean, artifact = 'ansible.builtin.ping'): NodeCode =>
    ({ artifact, tasks: [{}, {}], matched }) as unknown as NodeCode;
  const ran = (failed: boolean): RunSummary =>
    ({
      nodes: { n: { ok_hosts: ['a'] } },
      failures: failed ? [{ node: 'n', host: 'a' }] : [],
    }) as unknown as RunSummary;

  it('says the most important thing first', () => {
    const issue = { label: 'params differ' } as DriftItem;
    expect(codeState(bound, code(true), issue, ran(true))).toEqual({
      count: '2 tasks',
      state: 'drift: params differ',
      tone: 'warn',
    });
    expect(codeState(task, code(false, 'not bound'), undefined, undefined)).toEqual({
      state: 'runs as TODO stub',
      tone: 'neutral',
    });
    expect(codeState(bound, code(true), undefined, ran(true)).state).toBe('last run failed');
    expect(codeState(bound, code(true), undefined, ran(false))).toMatchObject({
      state: 'last run ok',
      tone: 'ok',
    });
    expect(codeState(bound, code(false), undefined, undefined)).toMatchObject({
      state: 'not in generated code',
      tone: 'warn',
    });
  });
});

describe('execution settings', () => {
  const field = (key: string) => EXECUTION_SETTINGS.find((s) => s.key === key);

  it('turns typed text into setting values and back', () => {
    const serial = field('serial');
    const retries = field('retries');
    const tags = field('tags');
    if (!serial || !retries || !tags) throw new Error('missing setting');
    expect(settingValue(serial, ' 2 ')).toBe(2);
    expect(settingValue(serial, '25%')).toBe('25%');
    expect(settingValue(retries, '3')).toBe(3);
    expect(settingProblem(retries, '3x')).toBe('A whole number');
    expect(settingValue(tags, 'a, b,,c')).toEqual(['a', 'b', 'c']);
    expect(settingValue(tags, '  ')).toBeNull();
    expect(settingText(['a', 'b'])).toBe('a, b');
    expect(settingText(undefined)).toBe('');
  });
});

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
  timingText,
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

  // AFD-111 (round 4: Q2): Delay is written like Timeout and kept as Ansible's number of seconds.
  it('takes Delay as a duration and shows it as one', () => {
    const delay = field('delay');
    if (!delay) throw new Error('missing setting');
    expect(['10s', '1m', '1m30s', '90', '0', ' 15 '].map((t) => settingValue(delay, t))).toEqual([
      10, 60, 90, 90, 0, 15,
    ]);
    expect(settingProblem(delay, '10s')).toBeUndefined();
    expect(settingProblem(delay, 'soon')).toBe(
      'A duration: 10s, 1m, 1m30s, or a number of seconds',
    );
    expect(settingValue(delay, '')).toBeNull();
    expect([10, 90, 0].map((v) => settingText(v, delay))).toEqual(['10s', '1m30s', '0s']);
  });
});

/**
 * AFD-111 (round 4: Q1, Q3): ansible-core 2.19 (task_executor.py) runs a task once, then retries it
 * up to `retries` times (3 with until and no retries), sleeping `delay` only between tries, and
 * each try has the whole `timeout`. The sentence counts the same.
 */
describe('timingText', () => {
  const r = 'wait_drain_result';
  it.each([
    [
      { retries: 12, delay: 10, until: "'drained' in wait_drain_result.stdout", timeout: '30s' },
      "Tries up to 13 times (once, then 12 retries), 10 s apart, until 'drained' in wait_drain_result.stdout; each try at most 30s; the step takes at most 8 min 30 s in all.",
    ],
    [
      { until: 'wait_drain_result.rc == 0' },
      "Tries up to 4 times (once, then 3 retries, Ansible's default), 5 s apart, until wait_drain_result.rc == 0.",
    ],
    [
      { retries: 1, delay: 60 },
      'Tries up to 2 times (once, then 1 retry), 1 min apart, until it succeeds (wait_drain_result is succeeded).',
    ],
    [
      { retries: 0, until: 'wait_drain_result.rc == 0', timeout: '1m' },
      'Tries once (Retries 0), and fails unless wait_drain_result.rc == 0; each try at most 1m.',
    ],
    [{ timeout: '30s' }, 'Runs once; each try at most 30s.'],
    [{ delay: 10 }, 'Runs once; Delay applies only with Retries or Until.'],
    [
      { retries: 2, timeout: 'soon' },
      'Tries up to 3 times (once, then 2 retries), 5 s apart, until it succeeds (wait_drain_result is succeeded); "soon" is not a duration, so no try has a limit.',
    ],
  ] as const)('%o', (settings, text) => expect(timingText(settings, r)).toBe(text));

  it('says nothing when no Timing field is set', () =>
    expect(timingText({ become: true }, r)).toBeUndefined());
});

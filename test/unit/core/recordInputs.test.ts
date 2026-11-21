// AFD-341: the values a step's inputs had per host in a run. The generated record task, the run
// view's reduction of the callback's inputs events, the switch, and the "differs" hint. The callback
// itself runs for real in the engine suite (test/engine/engine.test.ts, "record inputs").
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { optionA } from '../../../src/core/engine/optionA';
import { INPUT_MARK, recordInputsTask, secretInput } from '../../../src/core/engine/recordInputs';
import { buildModel } from '../../../src/core/flow/model';
import { inputOrigin } from '../../../src/core/flow/origin';
import type { FlowDocument, FlowNode } from '../../../src/core/flow/types';
import { runProcess } from '../../../src/core/run/command';
import { createSummarizer, summarizeRun } from '../../../src/core/run/events';
import {
  differsFromPredicted,
  hostInputs,
  inputValueGroups,
  nodeInputsRecorded,
  recordedText,
} from '../../../src/core/run/view';

const FLOW = readFileSync(join(__dirname, '../../fixtures/engine/record-inputs.flow.yaml'), 'utf8');
const doc = parse(FLOW) as FlowDocument;
const model = buildModel(doc);
const node = (key: string): FlowNode => {
  for (const e of model.nodes.values()) if (e.node.key === key) return e.node;
  throw new Error(key);
};
const SHOW = node('show').id;
/** The template the record task of a step sets afd_inputs to. */
const recordValue = (key: string): string => {
  const facts = recordInputsTask(model, node(key))?.['ansible.builtin.set_fact'] as
    | Record<string, string>
    | undefined;
  return String(facts?.afd_inputs);
};

const line = (e: Record<string, unknown>) => JSON.stringify(e);
const events = [
  line({ event: 'start', playbook: 'x.yml', record_inputs: true }),
  line({ event: 'play', name: '[show] Show what arrived', node: SHOW, ts: 1 }),
  line({
    event: 'inputs',
    host: 'h01',
    node: SHOW,
    ts: 2,
    inputs: {
      word: { value: 'hello' },
      creds: { value: { user: 'bob', password: '********' } },
      access: { missing: 'secret' },
      missing: { missing: 'undefined' },
      blob: { value: 'xxxx…xxxx', cut: 5002 },
      // A secret-looking name never keeps a value, whatever an older callback wrote.
      db_password: { value: 'leaked' },
    },
  }),
  line({
    event: 'inputs',
    host: 'h02',
    node: SHOW,
    ts: 2,
    inputs: { word: { value: 'hello' }, access: { missing: 'limit' } },
  }),
  line({ event: 'inputs', host: 'h03', node: SHOW, ts: 2, inputs: { word: { value: 'hi' } } }),
  line({ event: 'stats', hosts: {} }),
].join('\n');

describe('the record task (generated code)', () => {
  it('records every input as Ansible renders it, skipped when the run turns it off', () => {
    const task = recordInputsTask(model, node('show'));
    expect(task?.name).toBe('[show] record inputs');
    expect(task?.when).toBe("lookup('ansible.builtin.env', 'AFD_RECORD_INPUTS') != '0'");
    expect(task?.ignore_errors).toBe(true);
    const value = recordValue('show');
    // A vaulted value anywhere inside becomes a marker; an undefined one says so.
    expect(value.startsWith('{%- macro afd_vault(x) -%}')).toBe(true);
    expect(value).toContain(
      "'word': (('__afd_vault__' if afd_vault(word) else word) if word is defined else '__afd_undefined__')",
    );
  });

  it('never renders a secret: a secret-looking chain, a secret name, a no_log step', () => {
    expect(secretInput(model, node('show'), 'access')).toBe(true);
    expect(inputOrigin(model, node('show'), 'access').secret).toBe(true);
    const value = recordValue('show');
    expect(value).toContain(`'access': '${INPUT_MARK.secret}'`);
    expect(value).not.toContain('afd_vault(access)');
    const quiet = recordValue('quiet');
    // Nothing is rendered for a no_log step: no macro, only the marker.
    expect(quiet).toBe(`{{ {'word': '${INPUT_MARK.secret}'} }}`);
  });

  it('comes before the step, in its play; none for a step without inputs or a scenario build', () => {
    const text = optionA.generate(doc, { source: 'record-inputs.flow.yaml' }).files[0]?.text ?? '';
    const record = text.indexOf('- name: "[show] record inputs"');
    expect(record).toBeGreaterThan(0);
    expect(record).toBeLessThan(text.indexOf('[show] Show what arrived"\n          ansible'));
    expect(recordInputsTask(model, node('done'))).toBeUndefined();
    const sim = optionA.generate(doc, { source: 'x', simulate: true, stubAll: true });
    expect(sim.files.map((f) => f.text).join('\n')).not.toContain('record inputs');
  });
});

describe('the run view', () => {
  it('keeps each host’s values per node, secrets without a value', () => {
    const s = summarizeRun(events, {});
    expect(nodeInputsRecorded(s, SHOW)).toBe(true);
    expect(nodeInputsRecorded(s, node('quiet').id)).toBe(false);
    expect(hostInputs(s, SHOW, 'h01')?.word).toEqual({ value: 'hello' });
    expect(hostInputs(s, SHOW, 'h01')?.db_password).toEqual({ missing: 'secret' });
    expect(hostInputs(s, SHOW, 'h01')?.blob).toEqual({ value: 'xxxx…xxxx', cut: 5002 });
    expect(s.inputsOff).toBeUndefined();
    // The hosts of a run are still those of its task results.
    expect(s.hosts).toEqual([]);
  });

  it('says why a value is missing, and how long a cut one was', () => {
    const s = summarizeRun(events, {});
    const h01 = hostInputs(s, SHOW, 'h01') ?? {};
    expect(recordedText(h01.word)).toBe('hello');
    expect(recordedText(h01.creds)).toBe('{user: bob, password: "********"}');
    expect(recordedText(h01.access)).toBe('secret: not recorded');
    expect(recordedText(h01.missing)).toBe('not defined for this host');
    expect(recordedText(hostInputs(s, SHOW, 'h02')?.access)).toBe(
      "not recorded: the run's limit for values was reached",
    );
    expect(recordedText(h01.blob)).toBe('xxxx…xxxx (cut: 5002 characters)');
    expect(recordedText(undefined)).toBe('not recorded');
  });

  it('groups the hosts that had the same value, most hosts first', () => {
    const s = summarizeRun(events, {});
    expect(inputValueGroups(s, SHOW, 'word').map((g) => [g.text, g.hosts])).toEqual([
      ['hello', ['h01', 'h02']],
      ['hi', ['h03']],
    ]);
    expect(inputValueGroups(s, SHOW, 'nothing')).toEqual([]);
  });

  it('a partial summary has them too, and a run that turned recording off says so', () => {
    const live = createSummarizer({});
    for (const l of events.split('\n').slice(0, 3)) live.push(l);
    expect(hostInputs(live.summary({ partial: true }), SHOW, 'h01')?.word).toEqual({
      value: 'hello',
    });
    const off = summarizeRun(line({ event: 'start', record_inputs: false }), {});
    expect(off.inputsOff).toBe(true);
    expect(off.inputs).toBeUndefined();
  });
});

describe('differs from what was predicted', () => {
  it('compares a static value of the chain with the run’s, never a secret or a cut one', () => {
    const origin = inputOrigin(model, node('show'), 'creds');
    expect(differsFromPredicted(origin, { value: { user: 'bob', password: 'hunter2' } })).toBe(
      undefined,
    );
    expect(differsFromPredicted(origin, { value: { user: 'eve' } })).toMatch(
      /^differs from what the flow predicted \(/,
    );
    expect(differsFromPredicted(origin, { missing: 'undefined' })).toBeUndefined();
    expect(differsFromPredicted(origin, { value: 'x', cut: 9000 })).toBeUndefined();
    // A runtime source (a flow input given at launch) predicts nothing.
    expect(
      differsFromPredicted(inputOrigin(model, node('show'), 'word'), { value: 'other' }),
    ).toBeUndefined();
    expect(
      differsFromPredicted(inputOrigin(model, node('show'), 'access'), { value: 'x' }),
    ).toBeUndefined();
  });
});

describe('the switch', () => {
  const run = (recordInputs?: boolean) =>
    runProcess(
      { kind: 'local', python: 'python3' } as never,
      { root: '/repo', probe: '/ext/probe' },
      {
        playbook: 'g/x.yml',
        check: false,
        runDir: '/tmp/r',
        vault: false,
        hasConfig: false,
        ...(recordInputs === undefined ? {} : { recordInputs }),
      },
      'n',
    ).env;
  it('is on unless the run turns it off', () => {
    expect(run().AFD_RECORD_INPUTS).toBeUndefined();
    expect(run(true).AFD_RECORD_INPUTS).toBeUndefined();
    expect(run(false).AFD_RECORD_INPUTS).toBe('0');
  });
});

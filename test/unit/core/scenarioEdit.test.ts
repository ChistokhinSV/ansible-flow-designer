// AFD-115: the scenarios file as a document: each command is one byte-preserving edit, and the
// file still fits its flow afterwards.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import type { FlowDocument } from '../../../src/core/flow/types';
import {
  applyScenarioEdit,
  planScenarioEdit,
  type ScenarioCommand,
} from '../../../src/core/scenario/edit';
import { blocking, checkScenarios, parseScenarios } from '../../../src/core/scenario/scenarios';
import { applyEdits } from '../../../src/core/yaml/edits';

const FIX = join(__dirname, '../../fixtures/engine');
const DOC = parse(readFileSync(join(FIX, 'routing-levels.flow.yaml'), 'utf8')) as FlowDocument;
const TEXT = readFileSync(join(FIX, 'routing-levels.scenarios.yaml'), 'utf8');
const NL = String.fromCharCode(10);
const THIRD = 'a failed stage is handled, a failed gate stops the host there';

const edit = (cmd: ScenarioCommand, text: string | undefined = TEXT) => {
  const e = planScenarioEdit(text, cmd, DOC);
  if (text !== undefined) expect(applyEdits(text, e.edits)).toBe(e.text);
  return e.text;
};
const scenarios = (text: string) => {
  const file = parseScenarios(text).file;
  if (!file) throw new Error(text);
  expect(blocking(checkScenarios(DOC, file))).toEqual([]);
  return file.scenarios;
};
const named = (text: string, name: string) => scenarios(text).find((s) => s.name === name);

describe('the scenarios file as a document (AFD-115)', () => {
  it('creates the file with its first scenario', () => {
    const e = planScenarioEdit(
      undefined,
      {
        kind: 'add',
        scenario: {
          name: 'every host goes through',
          inputs: { devices: ['host-01', 'host-02'] },
          expect: { 'host-01': 'done', 'host-02': 'done' },
        },
      },
      DOC,
    );
    expect(e.created).toBe(true);
    expect(e.text).toMatch(/^# Scenario tests for flow routing-levels/);
    // As the hand-written files are: the list indented, host lists on one line.
    expect(e.text).toContain(`scenarios:${NL}  - name: every host goes through`);
    expect(e.text).toContain('devices: [host-01, host-02]');
    expect(scenarios(e.text)).toEqual([
      {
        name: 'every host goes through',
        inputs: { devices: ['host-01', 'host-02'] },
        expect: { 'host-01': 'done', 'host-02': 'done' },
      },
    ]);
    expect(applyScenarioEdit('', e)).toBe(e.text);
  });

  it('adds, renames, duplicates and deletes, leaving the rest as it was', () => {
    const added = edit({
      kind: 'add',
      scenario: {
        name: 'gate fails',
        inputs: { devices: ['h01'] },
        force: { gate: { failed: ['h01'] } },
        expect: { h01: 'gate.failed_hosts' },
      },
    });
    expect(added.startsWith(TEXT)).toBe(true);
    expect(named(added, 'gate fails')?.force).toEqual({ gate: { failed: ['h01'] } });
    const renamed = edit({ kind: 'rename', name: THIRD, to: 'stage and gate' });
    expect(renamed).toBe(TEXT.replace(`name: ${THIRD}`, 'name: stage and gate'));
    const copy = edit({ kind: 'duplicate', name: THIRD, to: 'again' });
    expect(scenarios(copy).map((s) => s.name)).toEqual([
      'every host goes through',
      'hosts as comma-separated text, as an AWX survey answers',
      THIRD,
      'again',
    ]);
    expect(named(copy, 'again')?.force).toEqual(named(TEXT, THIRD)?.force);
    const gone = edit({ kind: 'delete', name: 'every host goes through' });
    expect(scenarios(gone).map((s) => s.name)).toEqual([
      'hosts as comma-separated text, as an AWX survey answers',
      THIRD,
    ]);
    expect(gone.startsWith('# Scenario tests for the routing-levels')).toBe(true);
  });

  it('takes a host out with its expectation and forced outcomes', () => {
    const out = edit({ kind: 'setHosts', name: THIRD, hosts: ['h01', 'h03', 'h04', 'h05'] });
    const s = named(out, THIRD);
    expect(s?.inputs?.devices).toEqual(['h01', 'h03', 'h04', 'h05']);
    expect(s?.expect).toEqual({ h01: 'done', h03: 'gate.failed_hosts', h04: 'done', h05: 'done' });
    // stage/prepare forced only h02: the entry goes; gate's stays.
    expect(s?.force).toEqual({ gate: { failed: ['h03'] } });
    expect(out).toContain('devices: [h01, h03, h04, h05]');
  });

  it('forces and unforces outcomes, down to no force at all', () => {
    const more = edit({
      kind: 'force',
      name: THIRD,
      step: 'gate',
      outcome: 'failed',
      hosts: ['h03', 'h04'],
    });
    expect(named(more, THIRD)?.force?.gate).toEqual({ failed: ['h03', 'h04'] });
    const one = edit({ kind: 'force', name: THIRD, step: 'gate', outcome: 'failed', hosts: [] });
    expect(named(one, THIRD)?.force).toEqual({ 'stage/prepare': { failed: ['h02'] } });
    const none = edit(
      { kind: 'force', name: THIRD, step: 'stage/prepare', outcome: 'failed', hosts: [] },
      one,
    );
    expect(named(none, THIRD)?.force).toBeUndefined();
    const first = edit({
      kind: 'force',
      name: 'every host goes through',
      step: 'stage/prepare',
      outcome: 'failed',
      hosts: ['h02'],
    });
    expect(named(first, 'every host goes through')?.force).toEqual({
      'stage/prepare': { failed: ['h02'] },
    });
    // Written as the hand-written file writes it: no quotes around a sub/step key.
    expect(first).toContain('stage/prepare:');
  });

  it('sets expectations, one host or all at once', () => {
    const one = edit({ kind: 'expectHost', name: THIRD, host: 'h02', where: 'done' });
    expect(named(one, THIRD)?.expect?.h02).toBe('done');
    expect(one).toBe(TEXT.replace('h02: failed', 'h02: done'));
    const all = edit({
      kind: 'setExpect',
      name: 'every host goes through',
      expect: { h01: 'failed', h02: 'done' },
    });
    expect(named(all, 'every host goes through')?.expect).toEqual({ h01: 'failed', h02: 'done' });
  });

  it('names a command that does not fit the file', () => {
    expect(() => edit({ kind: 'delete', name: 'nope' })).toThrow('No scenario named "nope"');
    expect(() => edit({ kind: 'rename', name: THIRD, to: 'every host goes through' })).toThrow(
      'A scenario named "every host goes through" is already there',
    );
    expect(() => planScenarioEdit(undefined, { kind: 'delete', name: 'x' }, DOC)).toThrow(
      'This flow has no scenarios yet',
    );
  });
});

describe('the flow tools replace a scenario whole (AFD-117)', () => {
  it('writes it in place, renamed if asked, and keeps the other scenarios', () => {
    const out = edit({
      kind: 'replace',
      name: 'every host goes through',
      scenario: {
        name: 'one host fails the gate',
        inputs: { devices: ['h01', 'h02'] },
        force: { gate: { failed: ['h02'] } },
        expect: { h01: 'done', h02: 'gate.failed_hosts' },
      },
    });
    expect(scenarios(out).map((s) => s.name)).toEqual([
      'one host fails the gate',
      'hosts as comma-separated text, as an AWX survey answers',
      THIRD,
    ]);
    expect(out).toContain('devices: [h01, h02]');
    expect(() =>
      edit({
        kind: 'replace',
        name: THIRD,
        scenario: { name: 'every host goes through', expect: {} },
      }),
    ).toThrow('already there');
  });
});

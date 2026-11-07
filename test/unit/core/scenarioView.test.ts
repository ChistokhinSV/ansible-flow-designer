// AFD-84: a scenario's result shown on the canvas like a run, and an end node's expected and ended
// hosts, on the recorded routing-ports run.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { optionA } from '../../../src/core/engine/optionA';
import type { FlowDocument } from '../../../src/core/flow/types';
import { summarizeRun } from '../../../src/core/run/events';
import { runStates } from '../../../src/core/run/view';
import { DROPPED, forcedOf, hostEnds, judge } from '../../../src/core/scenario/scenarios';
import {
  endRows,
  endWords,
  forcedAt,
  forcedText,
  missText,
  missWhy,
  scenarioMisses,
  scenarioRun,
} from '../../../src/core/scenario/view';
import { describeResults } from '../../../src/node/scenario/runner';

const dir = join(__dirname, '../../fixtures/engine');
const doc = parse(readFileSync(join(dir, 'routing-ports.flow.yaml'), 'utf8')) as FlowDocument;
const { routes } = optionA.generate(doc, { source: 'routing-ports.flow.yaml' });
const summary = summarizeRun(readFileSync(join(dir, 'routing-ports.events.jsonl'), 'utf8'), routes);
const ends = hostEnds(doc, summary);
const id = (key: string) => doc.nodes.find((n) => n.key === key)?.id as string;

// h03 really ends at stopped; the scenario says it should reach failed.
const scenario = {
  name: 'h03 is reported',
  expect: { h01: ends.h01 as string, h03: 'failed' },
};
const result = judge(doc, scenario, summary);

describe('scenario on the canvas', () => {
  it('judge keeps the run summary; the misses name where each host ended', () => {
    expect(result.passed).toBe(false);
    expect(result.summary).toBe(summary);
    expect(scenarioMisses(result)).toEqual([
      { host: 'h03', expected: 'failed', actual: 'stopped' },
    ]);
  });

  it('a scenario reads as a run: the same node states as its summary, its verdict kept', () => {
    const run = scenarioRun(result, '2026-11-04T10:00:00Z');
    expect(run).toMatchObject({ source: 'scenario', mode: 'check', state: 'done', rc: 2 });
    expect(run.scenario?.name).toBe('h03 is reported');
    expect(runStates(doc, run.summary as typeof summary)).toEqual(runStates(doc, summary));
    expect(scenarioRun({ ...result, summary: undefined, error: 'no events' }, 'now').state).toBe(
      'error',
    );
  });

  it('an end node lists the hosts expected there and the hosts that came', () => {
    const run = scenarioRun(result, 'now');
    const failed = endRows(
      doc,
      run.scenario as NonNullable<typeof run.scenario>,
      run,
      id('failed'),
    );
    // h03 was expected at failed and ended at stopped; h05 came here without an expectation.
    expect(failed.find((r) => r.host === 'h03')).toEqual({
      host: 'h03',
      expected: true,
      ended: 'stopped',
      ok: false,
    });
    expect(failed.find((r) => r.host === 'h05')).toMatchObject({ expected: false, ok: true });
    const stopped = endRows(
      doc,
      run.scenario as NonNullable<typeof run.scenario>,
      run,
      id('stopped'),
    );
    expect(stopped.find((r) => r.host === 'h03')).toMatchObject({
      expected: false,
      ended: 'stopped',
    });
  });
});

describe('scenario ends in words (AFD-94)', () => {
  it("an end by its title, a step's open port, a host that dropped out", () => {
    expect(endWords(doc, 'stopped')).toBe(doc.nodes.find((n) => n.key === 'stopped')?.title);
    expect(endWords(doc, DROPPED)).toBe('dropped out of the run');
    expect(endWords(doc, 'no-such-end')).toBe('no-such-end');
    expect(missText(doc, { host: 'h03', expected: 'failed', actual: DROPPED })).toMatch(
      /^h03 dropped out of the run; the scenario expected /,
    );
  });
});

// AFD-105 (round 3: R8): a planted outcome in words, and one wording of a miss everywhere.
describe('planted outcomes in words (AFD-105)', () => {
  const planted = judge(
    doc,
    { ...scenario, force: { work: { failed: ['h03'] }, decide: { false: ['h01'] } } },
    summary,
  );

  it('the result carries what the scenario forced, with the port it sends to', () => {
    expect(planted.forced).toEqual([
      { host: 'h03', step: 'work', outcome: 'failed', port: 'failed_hosts' },
      { host: 'h01', step: 'decide', outcome: 'false', port: 'false' },
    ]);
    expect(forcedOf({})).toEqual([]);
    expect(scenarioRun(planted, 'now').scenario?.forced).toEqual(planted.forced);
  });

  it('says what was forced, where, and why a miss happened', () => {
    const [work] = planted.forced ?? [];
    expect(forcedText(doc, work as NonNullable<typeof work>)).toBe(
      'the scenario forces Work to fail for it (force: failed), so it leaves by failed_hosts',
    );
    expect(forcedAt(doc, planted.forced, 'h03', id('work'))?.outcome).toBe('failed');
    expect(forcedAt(doc, planted.forced, 'h03', id('probe'))).toBeUndefined();
    const [miss] = scenarioMisses(planted);
    expect(missWhy(doc, miss as NonNullable<typeof miss>, planted.forced)).toBe(
      `h03 ended at ${endWords(doc, 'stopped')}; the scenario expected ${endWords(doc, 'failed')}, because the scenario forces Work to fail for it (force: failed), so it leaves by failed_hosts`,
    );
  });

  it('the log says the same, with the keys a scenario file uses', () => {
    const lines = describeResults([planted], doc);
    expect(lines[0]).toBe('FAIL h03 is reported');
    expect(lines[1]).toMatch(
      /^ {2}h03 ended at .+ \(stopped\); the scenario expected .+ \(failed\), because the scenario forces Work to fail/,
    );
    // Without the flow at hand, the keys as they are.
    expect(describeResults([planted])[1]).toMatch(
      /^ {2}h03 ended at stopped; the scenario expected failed, because the scenario forces work to fail/,
    );
  });
});

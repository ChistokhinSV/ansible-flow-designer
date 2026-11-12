// AFD-245: what the Run panel lists of a kept run.
import { describe, expect, it } from 'vitest';
import type { RunView } from '../../../src/core/protocol';
import { pastRunLabel, pastRunOf } from '../../../src/core/run/pastRuns';

const run = (more: Partial<RunView> = {}): RunView =>
  ({
    id: '20261112T140200Z',
    mode: 'check',
    state: 'done',
    startedAt: '2026-11-12T14:02:00.000Z',
    flowVersion: 7,
    summary: {
      hosts: ['sw1', 'sw2', 'sw3'],
      nodes: {},
      outcome: { sw2: 'failed' },
      failures: [{ host: 'sw2' }, { host: 'sw3' }],
    },
    ...more,
  }) as unknown as RunView;

describe('kept runs (AFD-245)', () => {
  it('a finished run: hosts, the hosts that failed counted once, the version it ran', () => {
    expect(pastRunOf(run())).toEqual({
      id: '20261112T140200Z',
      mode: 'check',
      startedAt: '2026-11-12T14:02:00.000Z',
      ok: true,
      hosts: 3,
      failed: 2,
      flowVersion: 7,
    });
  });

  it('a run still going, or one that never got events, is not listed', () => {
    expect(pastRunOf(run({ state: 'running' }))).toBeUndefined();
    expect(pastRunOf(run({ summary: undefined }))).toBeUndefined();
  });

  it('the line says the kind and the result', () => {
    const past = pastRunOf(run());
    expect(past && pastRunLabel(past, 'en-GB')).toMatch(/· skeleton · 3 hosts, 2 failed$/);
    const real = pastRunOf(
      run({
        mode: 'real',
        summary: { hosts: ['sw1'], nodes: {}, outcome: {}, failures: [] } as never,
      }),
    );
    expect(real && pastRunLabel(real, 'en-GB')).toMatch(/· real run · 1 host, all passed$/);
    const part = pastRunOf(
      run({ partial: { node: 'n', only: true, line: 'Ran "Validate" alone', stubbed: [] } }),
    );
    expect(part?.partial).toBe('Ran "Validate" alone');
    expect(part && pastRunLabel(part, 'en-GB')).toContain('· part of the flow ·');
    const stopped = pastRunOf(run({ state: 'error' }));
    expect(stopped && pastRunLabel(stopped, 'en-GB')).toMatch(/did not finish$/);
  });
});

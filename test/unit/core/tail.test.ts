// AFD-81: the run's events read while they are written, and the secrets kept out of them.
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RunSummary } from '../../../src/core/run/events';
import {
  REDACTED,
  redactLine,
  redactText,
  revealAfterRun,
  secretValues,
} from '../../../src/core/run/redact';
import { tailFile } from '../../../src/node/run/tail';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('tailFile', () => {
  it('hands over each complete line once, a cut line when it ends, the rest on stop', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'afd-tail-'));
    dirs.push(dir);
    const file = join(dir, 'events.jsonl');
    const got: string[] = [];
    const tail = tailFile(file, (lines) => got.push(...lines), 20);
    await wait(60); // no file yet: nothing, no error
    // AFD-166: wait for what the polls hand over, not a fixed time: under the full suite's load a
    // poll came later than 80 ms and the test failed now and then.
    const settle = { timeout: 5000, interval: 20 };
    writeFileSync(file, '{"event":"start"}\n{"event":"pl');
    await vi.waitFor(() => expect(got).toEqual(['{"event":"start"}']), settle);
    appendFileSync(file, 'ay"}\n{"host":"lab-sw-01 é"}\n{"event":"stats"}');
    await vi.waitFor(
      () =>
        expect(got).toEqual(['{"event":"start"}', '{"event":"play"}', '{"host":"lab-sw-01 é"}']),
      settle,
    );
    // A few more polls: the cut line at the end is not handed over before stop.
    await wait(100);
    expect(got).toHaveLength(3);
    await tail.stop();
    expect(got.at(-1)).toBe('{"event":"stats"}');
    expect(got).toHaveLength(4);
  });
});

describe('redact', () => {
  const secrets = secretValues({
    enable_secret: 'S3cr3t!',
    api_key: 'k-123',
    pin: 4321,
    empty: '',
  });

  it('replaces secret values inside every string and keeps the line JSON', () => {
    const line = JSON.stringify({
      event: 'result',
      host: 'lab-sw-01',
      out: { stdout: 'enable secret S3cr3t! ok', msg: ['key k-123', 'pin 4321'] },
    });
    const out = JSON.parse(redactLine(line, secrets));
    expect(out.out.stdout).toBe(`enable secret ${REDACTED} ok`);
    expect(out.out.msg).toEqual([`key ${REDACTED}`, `pin ${REDACTED}`]);
    expect(out.host).toBe('lab-sw-01');
  });

  it('leaves text alone without secrets, and drops a line it cannot read', () => {
    expect(redactText('a\nb', [])).toBe('a\nb');
    expect(redactText('{"x":"S3cr3t!"}\nnot json', secrets)).toBe(`{"x":"${REDACTED}"}\n`);
    expect(secrets).not.toContain('');
  });
});

describe('revealAfterRun', () => {
  const summary = (s: Partial<RunSummary>): RunSummary => ({
    nodes: {},
    outcome: {},
    failures: [],
    unreachable: [],
    hosts: [],
    stoppedEarly: false,
    ...s,
  });
  const base = { designerOpen: true, stopped: false, rc: 0, events: true, summary: summary({}) };

  it('a run the canvas shows keeps the terminal out of the way', () => {
    expect(revealAfterRun(base)).toBe(false);
    expect(
      revealAfterRun({ ...base, rc: 2, summary: summary({ outcome: { h1: 'Ended at Stopped' } }) }),
    ).toBe(false);
  });

  it('shows the terminal when the canvas has nothing to say', () => {
    expect(revealAfterRun({ ...base, rc: undefined })).toBe(true);
    expect(revealAfterRun({ ...base, events: false })).toBe(true);
    // An inventory or syntax error before the first play: rc 4, nothing summarized.
    expect(revealAfterRun({ ...base, rc: 4 })).toBe(true);
  });

  it('without a designer the terminal was shown from the start; a stop needs nothing', () => {
    expect(revealAfterRun({ ...base, designerOpen: false, rc: 4 })).toBe(false);
    expect(revealAfterRun({ ...base, stopped: true, rc: undefined })).toBe(false);
  });
});

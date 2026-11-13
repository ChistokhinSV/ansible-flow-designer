// AFD-81: the run summary line by line while the run goes. Pushed line by line, the summarizer
// matches the batch summary of every prefix; a partial summary holds back failures the play may
// still rescue, names the running node and never says the run stopped early.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { optionA } from '../../../src/core/engine/optionA';
import type { FlowDocument } from '../../../src/core/flow/types';
import { createSummarizer, splitLines, summarizeRun } from '../../../src/core/run/events';
import { runStates } from '../../../src/core/run/view';

const dir = join(__dirname, '../../fixtures/engine');
const doc = parse(readFileSync(join(dir, 'routing-ports.flow.yaml'), 'utf8')) as FlowDocument;
const { routes } = optionA.generate(doc, { source: 'routing-ports.flow.yaml' });
const lines = readFileSync(join(dir, 'routing-ports.events.jsonl'), 'utf8').split('\n');
const id = (key: string) => doc.nodes.find((n) => n.key === key)?.id ?? '';

describe('createSummarizer', () => {
  it('pushed line by line, its summary is the batch summary of every prefix', () => {
    const s = createSummarizer(routes);
    for (let i = 0; i < lines.length; i++) {
      s.push(lines[i] as string);
      // Asking for a summary, partial or full, changes nothing that follows.
      s.summary({ partial: true });
      expect(s.summary()).toEqual(summarizeRun(lines.slice(0, i + 1).join('\n'), routes));
    }
  });

  it('a partial summary names the running node and holds back what a rescue may route', () => {
    const s = createSummarizer(routes);
    const play = (key: string) =>
      JSON.stringify({ event: 'play', name: `[x] ${key}`, node: id(key), ts: 1 });
    const failed = JSON.stringify({
      event: 'result',
      status: 'failed',
      host: 'h01',
      task: 'Work',
      node: id('work'),
      msg: 'boom',
      ts: 2,
    });
    s.push(play('work'));
    s.push(failed);
    const live = s.summary({ partial: true });
    expect(live.running).toBe(id('work'));
    // Not yet lost: the block's rescue comes next in the same play.
    expect(live.failures).toEqual([]);
    expect(live.stoppedEarly).toBe(false);
    expect(live.problems?.[id('work')]?.h01?.msg).toBe('boom');
    // The full summary of the same lines calls it lost, as a finished run would.
    expect(s.summary().failures).toHaveLength(1);
    expect(s.summary().running).toBeUndefined();
    expect(runStates(doc, live)[id('work')]?.state).toBe('running');
  });

  it('after the stats, no node is running', () => {
    const s = createSummarizer(routes);
    for (const line of lines) s.push(line);
    expect(s.summary({ partial: true }).running).toBeUndefined();
  });

  it("counts Ansible's implicit localhost as a host when a step runs on it, not for bookkeeping", () => {
    const s = createSummarizer(routes);
    const result = (node?: string) =>
      JSON.stringify({ event: 'result', status: 'ok', host: 'localhost', task: 't', ts: 2, node });
    // A play of the generator's own (restore host sets, outcome): no node.
    s.push(JSON.stringify({ event: 'play', name: '[x] Segment 1: restore host sets', ts: 1 }));
    s.push(result());
    expect(s.summary().hosts).toEqual([]);
    s.push(JSON.stringify({ event: 'play', name: '[x] work', node: id('work'), ts: 3 }));
    s.push(result(id('work')));
    expect(s.summary().hosts).toEqual(['localhost']);
  });
});

describe('splitLines', () => {
  it('keeps a line cut between two reads until its end arrives', () => {
    const a = splitLines('', '{"a":1}\n{"b"');
    expect(a).toEqual({ lines: ['{"a":1}'], carry: '{"b"' });
    expect(splitLines(a.carry, ':2}\n')).toEqual({ lines: ['{"b":2}'], carry: '' });
    expect(splitLines('', 'no end yet')).toEqual({ lines: [], carry: 'no end yet' });
  });
});

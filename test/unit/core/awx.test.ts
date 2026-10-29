// M7 (AFD-10): a real AWX job (lab, afd-awx-ee:2.19) of the awx-e2e flow, mapped back to nodes and
// ports through the engine's routes, exactly like local runs.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { awxEventsToLines, playNodes } from '../../../src/core/awx/events';
import type { AwxJobEvent } from '../../../src/core/awx/types';
import { optionA } from '../../../src/core/engine/optionA';
import { planCommand } from '../../../src/core/flow/commands';
import { createIdFactory } from '../../../src/core/flow/ids';
import { buildModel } from '../../../src/core/flow/model';
import type { FlowDocument } from '../../../src/core/flow/types';
import type { RunView } from '../../../src/core/protocol';
import { summarizeRun } from '../../../src/core/run/events';
import {
  arrivals,
  edgeHosts,
  nodeHosts,
  nodeRun,
  runPassed,
  runStates,
  testedCandidates,
  wireHosts,
} from '../../../src/core/run/view';
import { applyEdits } from '../../../src/core/yaml';

const DIR = join(__dirname, '../../fixtures/awx');
const FLOW = readFileSync(join(DIR, 'repo/flows/awx-e2e/awx-e2e.flow.yaml'), 'utf8');
const doc = parse(FLOW) as FlowDocument;
const { events } = JSON.parse(readFileSync(join(DIR, 'job-events.json'), 'utf8')) as {
  events: AwxJobEvent[];
};
const id = (key: string) => doc.nodes.find((n) => n.key === key)?.id as string;

describe('AWX job events → run summary', () => {
  const generated = optionA.generate(doc, { source: 'awx-e2e.flow.yaml' });

  it('the fixture repository holds the code the engine generates (what AWX ran)', () => {
    for (const f of generated.files)
      expect(readFileSync(join(DIR, 'repo/flows/awx-e2e/generated', f.name), 'utf8')).toBe(f.text);
  });

  it('every host took the ports the flow designs', () => {
    const summary = summarizeRun(awxEventsToLines(events, playNodes(doc)), generated.routes);
    expect(summary.nodes).toEqual({
      [id('probe')]: { ok_hosts: ['h01', 'h02'], unreachable: ['h07'] },
      [id('work')]: { ok_hosts: ['h01'], failed_hosts: ['h02'] },
      [id('exclude')]: { ok_hosts: ['h07'] },
      [id('notify')]: { ok_hosts: ['h02'] },
    });
    expect(summary.outcome).toEqual({ h02: 'Ended at [failed] Failed (outcome: failed)' });
    expect(summary.failures).toEqual([]);
    expect(summary.unreachable).toEqual([]);
    expect(summary.hosts).toEqual(['h01', 'h02', 'h07']);
    expect(summary.stoppedEarly).toBe(false);
    for (const key of ['probe', 'work', 'exclude', 'notify']) {
      const t = summary.timings?.[id(key)];
      expect(t, key).toBeDefined();
      expect((t?.end ?? 0) >= (t?.start ?? 1)).toBe(true);
    }
  });

  it('plays map to nodes by their generated name', () => {
    const plays = playNodes(doc);
    expect(plays.get('[probe] Probe reachability')).toBe(id('probe'));
    const lines = awxEventsToLines(events, plays)
      .split('\n')
      .map((l) => JSON.parse(l));
    const unreachable = lines.find((l) => l.status === 'unreachable');
    expect(unreachable).toMatchObject({ host: 'h07', node: id('probe') });
    expect(unreachable.msg).toContain('Failed to connect');
  });
});

describe('Run mode read-outs (04 §10) and tested proposals (decision 15)', () => {
  const generated = optionA.generate(doc, { source: 'awx-e2e.flow.yaml' });
  const summary = summarizeRun(awxEventsToLines(events, playNodes(doc)), generated.routes);
  const job: RunView = {
    id: 'r1',
    mode: 'real',
    state: 'done',
    rc: 2,
    startedAt: '2026-10-29T08:00:00Z',
    source: 'awx',
    flowVersion: doc.flow.version,
    summary,
  };

  it('per node: hosts, failures through fail ports, the reason per host', () => {
    expect(nodeRun(summary, id('probe'))).toMatchObject({ state: 'warn', hosts: 3, failed: 1 });
    expect(nodeRun(summary, id('exclude'))).toMatchObject({ state: 'ok', hosts: 1, failed: 0 });
    // No play of its own: nodeRun sees nothing; runStates counts what start sent and ends received.
    expect(nodeRun(summary, id('failed')).state).toBe('idle');
    const states = runStates(doc, summary);
    expect(states[id('start')]).toMatchObject({ state: 'ok', hosts: 3 });
    expect(states[id('done')]).toMatchObject({ state: 'ok', hosts: 1 });
    expect(states[id('excluded')]).toMatchObject({ state: 'ok', hosts: 1 });
    expect(states[id('failed')]).toMatchObject({ state: 'failed', hosts: 1, failed: 1 });
    const model = buildModel(doc);
    const fromStart = doc.edges.find((e) => e.from.node === id('start'));
    expect(fromStart && edgeHosts(model, summary, fromStart)).toEqual(['h01', 'h02', 'h07']);
    expect(arrivals(model, summary, id('failed'))).toEqual(['h02']);
    const work = nodeHosts(summary, id('work'));
    expect(work.map((h) => [h.host, h.ports])).toEqual([
      ['h01', ['ok_hosts']],
      ['h02', ['failed_hosts']],
    ]);
    expect(work[1]?.problem?.status).toBe('failed');
    expect(work[1]?.problem?.task).toContain('[work]');
    expect(nodeHosts(summary, id('probe')).find((h) => h.host === 'h07')?.problem?.status).toBe(
      'unreachable',
    );
    expect(wireHosts(summary, id('probe'), 'unreachable')).toEqual(['h07']);
  });

  it('only a passing real run of the current version proposes tested, for implemented nodes it ran', () => {
    expect(runPassed(job)).toBe(false);
    expect(testedCandidates(doc, job)).toEqual([]);
    const passed: RunView = { ...job, rc: 0, summary: { ...summary, outcome: {} } };
    expect(runPassed(passed)).toBe(true);
    expect(testedCandidates(doc, passed).sort()).toEqual([id('probe'), id('work')].sort());
    expect(testedCandidates(doc, { ...passed, mode: 'check' })).toEqual([]);
    expect(testedCandidates(doc, { ...passed, flowVersion: doc.flow.version - 1 })).toEqual([]);
  });

  it('setStatuses changes only the status lines, in one edit', () => {
    const r = planCommand(
      FLOW,
      { kind: 'setStatuses', statuses: { [id('probe')]: 'tested', [id('work')]: 'tested' } },
      { newId: createIdFactory() },
    );
    expect(applyEdits(FLOW, r.edits)).toBe(r.text);
    const after = parse(r.text) as FlowDocument;
    expect(after.nodes.find((n) => n.key === 'probe')?.status).toBe('tested');
    expect(after.nodes.find((n) => n.key === 'work')?.status).toBe('tested');
    const before = FLOW.split('\n');
    const changed = r.text.split('\n').filter((l, i) => l !== before[i]);
    expect(changed).toEqual(['    status: tested', '    status: tested']);
  });
});

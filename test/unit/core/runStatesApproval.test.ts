import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import type { FlowDocument } from '../../../src/core/flow/types';
import type { RunSummary } from '../../../src/core/run/events';
import { runStates } from '../../../src/core/run/view';

const doc = parse(
  readFileSync(join(__dirname, '../../fixtures/engine/approval-segments.flow.yaml'), 'utf8'),
) as FlowDocument;
const id = (key: string) => doc.nodes.find((n) => n.key === key)?.id as string;

const summary = (nodes: RunSummary['nodes'], timings: RunSummary['timings'] = {}): RunSummary => ({
  nodes,
  outcome: {},
  failures: [],
  unreachable: [],
  hosts: ['h1', 'h2'],
  stoppedEarly: false,
  timings,
});

describe('AFD-327: run read-outs on a server that splits the run at approvals', () => {
  it('an approval counts the hosts that arrived, while it waits', () => {
    const states = runStates(doc, summary({ [id('check')]: { ok_hosts: ['h1', 'h2'] } }));
    expect(states[id('gate')]).toMatchObject({ state: 'ok', hosts: 2 });
  });

  it('a play that ran for no host is not reached, not a green 0 hosts', () => {
    const states = runStates(
      doc,
      summary(
        { [id('check')]: { failed_hosts: ['h1', 'h2'] } },
        { [id('change')]: { start: 1, end: 1.1 } },
      ),
    );
    expect(states[id('gate')]).toMatchObject({ state: 'idle', hosts: 0 });
    expect(states[id('change')]).toMatchObject({ state: 'idle', hosts: 0 });
  });
});

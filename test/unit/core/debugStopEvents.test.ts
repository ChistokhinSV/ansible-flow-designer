// AFD-379: Stop at a failure pause, from events.jsonl a real run wrote (ansible-core 2.21, the
// engine suite's edge-baseline scenarios, AFD_KEEP_EVENTS). The server reads the same lines.
// - Stop at the failure pause: the failed host stays failed at the step, not by its fail port;
// - Retry, the step fails again, then Stop: the same;
// - Step past a failure (the host goes on by its fail port), then Stop before the next step:
//   the host keeps that route.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { optionA } from '../../../src/core/engine/optionA';
import type { FlowDocument } from '../../../src/core/flow/types';
import { summarizeRun } from '../../../src/core/run/events';
import { stepState } from '../../../src/core/run/step';
import { nodeRun } from '../../../src/core/run/view';

const REPO = join(__dirname, '../../..');
const doc = parse(
  readFileSync(join(REPO, 'examples/edge-baseline.flow.yaml'), 'utf8'),
) as FlowDocument;
const generated = optionA.generate(doc, { source: 'edge-baseline.flow.yaml', simulate: true });
const routes = generated.ok ? generated.routes : {};
const id = (key: string) => doc.nodes.find((n) => n.key === key)?.id as string;
const events = (name: string) =>
  readFileSync(join(REPO, 'test/fixtures/debug/events', `${name}.events.jsonl`), 'utf8');
const lines = (text: string) =>
  text
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
const OK = ['sw-edge-01', 'sw-edge-02', 'sw-edge-03'];

describe('AFD-379: Stop at a failure pause, real events', () => {
  it('the generated code routes (the fixtures match the flow)', () => {
    expect(generated.ok).toBe(true);
    expect(Object.keys(routes).length).toBeGreaterThan(0);
  });

  for (const name of ['stop-at-failure', 'retry-then-stop'])
    it(`${name}: the failed host is failed at the step, the others stopped after it`, () => {
      const text = events(name);
      const precheck = id('precheck');
      expect(stepState(lines(text)).stopped).toEqual({
        node: precheck,
        hosts: OK,
        reason: 'driver',
        after: true,
        failed: ['sw-edge-04'],
      });
      const s = summarizeRun(text, routes);
      expect(s.nodes[precheck]).toEqual({ ok_hosts: OK });
      expect(s.failures).toEqual([
        {
          host: 'sw-edge-04',
          node: precheck,
          task: '[precheck] TODO',
          msg: 'TODO: Verify reachability and current OS version',
        },
      ]);
      expect(s.outcome).toEqual({});
      expect(Object.values(s.nodes).flatMap((p) => Object.values(p).flat())).not.toContain(
        'sw-edge-04',
      );
      expect(nodeRun(s, precheck)).toMatchObject({ state: 'failed', hosts: 4, failed: 1 });
    });

  it('a host that went on by its fail port, then Stop before a step, keeps its route', () => {
    const text = events('fail-port-then-stop');
    const stopped = stepState(lines(text)).stopped;
    expect(stopped).toEqual({ node: id('backup-config'), hosts: OK, reason: 'driver' });
    const s = summarizeRun(text, routes);
    expect(s.nodes[id('precheck')]).toEqual({ ok_hosts: OK, failed_hosts: ['sw-edge-04'] });
    expect(s.failures).toEqual([]);
  });
});

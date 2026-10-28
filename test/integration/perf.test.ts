// Performance on the production bundle (07 §6: never measure the dev build). Budgets from the M1
// plan: snapshot → first paint ≤ 300 ms for os-upgrade; command round trip ≤ 100 ms (median).
import * as assert from 'node:assert/strict';
import { parse } from 'yaml';
import type { FlowDocument } from '../../src/core/flow/types';
import { closeAll, documentOf, flowUri, openDesigner, testApi, withTimeout } from './helpers';

const OS = flowUri('os-upgrade');

describe('M1 performance (production bundle)', () => {
  after(closeAll);

  it('first render and command round trip on os-upgrade', async () => {
    const api = await testApi();
    const doc = await openDesigner(OS);
    const first = api.perf(OS).find((p) => p.event === 'firstRender');
    assert.ok(first, 'firstRender reported');

    const start = (parse(doc.getText()) as FlowDocument).nodes[0]?.id as string;
    const trips: number[] = [];
    const renders: number[] = [];
    for (let i = 0; i < 15; i++) {
      const t0 = performance.now();
      const outcome = await api.run(OS, {
        kind: 'moveNodes',
        positions: { [start]: { x: 10 + i * 7, y: 0 } },
      });
      assert.ok(outcome.ok, outcome.error);
      await withTimeout(api.rendered(OS, documentOf(OS).version), 10_000, 'render');
      trips.push(performance.now() - t0);
      const r = api
        .perf(OS)
        .filter((p) => p.event === 'render')
        .at(-1);
      if (r) renders.push(r.ms);
    }
    const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? 0;
    const report = {
      firstRenderMs: Math.round(first.ms),
      roundTripMedianMs: Math.round(median(trips)),
      roundTripMaxMs: Math.round(Math.max(...trips)),
      webviewRenderMedianMs: Math.round(median(renders)),
    };
    console.log(`[perf] ${JSON.stringify(report)}`);
    assert.ok(report.firstRenderMs <= 300, `first render ${report.firstRenderMs} ms`);
    assert.ok(report.roundTripMedianMs <= 100, `round trip ${report.roundTripMedianMs} ms`);
  });
});

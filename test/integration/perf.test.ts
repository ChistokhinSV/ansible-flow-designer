// Performance on the production bundle (07 §6: never measure the dev build). Budgets from the M1
// plan: snapshot → first paint ≤ 300 ms for os-upgrade; command round trip ≤ 100 ms (median), which
// M2 also applies to its heaviest command, a failure pattern (nodes, edges, layout in one edit).
import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { parse } from 'yaml';
import type { FlowDocument } from '../../src/core/flow/types';
import { closeAll, documentOf, flowUri, openDesigner, testApi, withTimeout } from './helpers';

const OS = flowUri('os-upgrade');
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? 0;

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

  it('failure pattern round trip on os-upgrade (M2)', async () => {
    const api = await testApi();
    const doc = await openDesigner(OS);
    const original = doc.getText();
    const from = (parse(original) as FlowDocument).nodes.find((n) => n.key === 'restore-traffic');
    assert.ok(from);
    const trips: number[] = [];
    for (let i = 0; i < 10; i++) {
      const t0 = performance.now();
      const outcome = await api.run(OS, {
        kind: 'applyPattern',
        pattern: 'notify-stop',
        from: { node: from.id, port: 'failed_hosts' },
        position: { x: 600, y: 900 },
      });
      assert.ok(outcome.ok, outcome.error);
      await withTimeout(api.rendered(OS, documentOf(OS).version), 10_000, 'render');
      trips.push(performance.now() - t0);
      await vscode.commands.executeCommand('undo');
      assert.equal(doc.getText(), original);
    }
    const ms = Math.round(median(trips));
    console.log(`[perf] ${JSON.stringify({ patternRoundTripMedianMs: ms })}`);
    assert.ok(ms <= 100, `pattern round trip ${ms} ms`);
  });
});

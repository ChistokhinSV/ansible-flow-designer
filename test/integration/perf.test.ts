// Performance on the production bundle (07 §6: never measure the dev build). Budgets from the M1
// plan: snapshot → first paint ≤ 300 ms for os-upgrade; command round trip ≤ 100 ms (median), which
// M2 also applies to its heaviest command, a failure pattern (nodes, edges, layout in one edit).
import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { parse } from 'yaml';
import type { FlowDocument } from '../../src/core/flow/types';
import {
  closeAll,
  documentOf,
  flowUri,
  openDesigner,
  runEnvironment,
  testApi,
  withTimeout,
} from './helpers';

const OS = flowUri('os-upgrade');
const HELLO = flowUri('hello');
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

  // Wave 8 (AFD-78): how long after a skeleton run starts the canvas shows the first node's result,
  // against the run's own length. Before wave 8 both were the whole run; since AFD-81 the result
  // comes while the run goes (a running step is not a result).
  (runEnvironment ? it : it.skip)('first node result on the canvas during a run', async () => {
    const api = await testApi();
    await openDesigner(HELLO);
    api.setMode(HELLO, 'run');
    const t0 = performance.now();
    let firstNodeMs: number | undefined;
    let finished = false;
    const run = api.runFlow(HELLO, { mode: 'check', inputs: { devices: ['localhost'] } });
    void run.finally(() => {
      finished = true;
    });
    while (!finished && performance.now() - t0 < 240_000) {
      const states = Object.values((await api.inspect(HELLO)).run?.nodes ?? {});
      if (firstNodeMs === undefined && states.some((s) => s && s !== 'idle' && s !== 'running'))
        firstNodeMs = Math.round(performance.now() - t0);
      await new Promise((r) => setTimeout(r, 100));
    }
    const done = await withTimeout(run, 10_000, 'Hello skeleton run');
    const runMs = Math.round(performance.now() - t0);
    if (firstNodeMs === undefined) {
      await api.rendered(HELLO, documentOf(HELLO).version);
      const states = Object.values((await api.inspect(HELLO)).run?.nodes ?? {});
      if (states.some((s) => s && s !== 'idle')) firstNodeMs = runMs;
    }
    console.log(`[perf] ${JSON.stringify({ firstNodeResultMs: firstNodeMs ?? null, runMs })}`);
    assert.equal(done.state, 'done', JSON.stringify(done));
    assert.ok(firstNodeMs !== undefined && firstNodeMs < runMs, 'no node result before the end');
  }).timeout(300_000);
});

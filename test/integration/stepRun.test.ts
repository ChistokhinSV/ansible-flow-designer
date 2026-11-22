// AFD-346 (ADR-0039) inside VS Code, in the run environment (AFD_TEST_IMAGE, AFD_TEST_WSL or
// AFD_TEST_SSH; skipped without one): the Hello sample run step by step. It pauses before its
// first step with the canvas showing it, Step runs that one and pauses before the next, Continue
// runs on to a pause point, Stop ends the run there as stopped (not failed), and the steps before
// keep their results.
import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { parse } from 'yaml';
import type { FlowDocument } from '../../src/core/flow/types';
import type { RunView } from '../../src/core/protocol';
import { closeAll, flowUri, openDesigner, runEnvironment, testApi, withTimeout } from './helpers';

const HELLO = flowUri('hello');
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

(runEnvironment ? describe : describe.skip)(
  `AFD-346: step-by-step runs in ${runEnvironment ?? 'a run environment'}`,
  () => {
    afterEach(closeAll);

    it('Hello: pauses before each step; Step, a pause point with Continue, then Stop', async () => {
      const doc = await openDesigner(HELLO);
      const api = await testApi();
      api.setMode(HELLO, 'run');
      const flow = parse(doc.getText()) as FlowDocument;
      const id = (key: string) => flow.nodes.find((n) => n.key === key)?.id as string;

      /** Waits until the canvas shows the run paused before `key`. */
      const pausedAt = async (key: string, done: () => boolean) => {
        const t0 = Date.now();
        let seen: unknown;
        while (Date.now() - t0 < 120_000) {
          if (done()) throw new Error(`the run ended before it paused at ${key}`);
          const run = (await api.inspect(HELLO)).run;
          seen = run?.paused;
          if (run?.paused?.node === id(key)) return run.paused;
          await pause(150);
        }
        throw new Error(`not paused at ${key}: ${JSON.stringify(seen)}`);
      };

      let finished: RunView | undefined;
      const going = api.runFlow(HELLO, {
        mode: 'check',
        inputs: { devices: ['localhost'] },
        step: true,
      });
      void going.then((r) => {
        finished = r;
      });
      const ended = () => finished !== undefined;

      // Before the first step, its one host waiting there.
      assert.deepEqual(await pausedAt('ping', ended), { node: id('ping'), hosts: 1 });
      const t0 = Date.now();
      await vscode.commands.executeCommand('afd.run.step', HELLO);
      await pausedAt('facts', ended);
      const stepMs = Date.now() - t0;

      // A pause point on the last step: Continue runs facts without pausing and stops there.
      const points = (await vscode.commands.executeCommand(
        'afd.run.togglePausePoint',
        HELLO,
        id('say-hello'),
      )) as string[];
      assert.deepEqual(points, [id('say-hello')]);
      try {
        await vscode.commands.executeCommand('afd.run.continue', HELLO);
        await pausedAt('say-hello', ended);
        // Stop (Shift+F5) while paused: the run ends there, stats written, as stopped.
        await vscode.commands.executeCommand('afd.run.stop', HELLO);
        const run = await withTimeout(going, 60_000, 'stopped step-by-step run');
        assert.equal(run.state, 'error', JSON.stringify(run));
        assert.equal(run.errorCode, 'cancelled');
        assert.equal(run.rc, 2);
        assert.equal(run.stoppedAt, id('say-hello'));
        assert.match(run.error ?? '', /^Stopped before /);
        assert.deepEqual(run.step?.stopped, {
          node: id('say-hello'),
          hosts: ['localhost'],
          reason: 'driver',
        });
        assert.equal(run.step?.pauses, 3);
        // The steps before ran; the one it stopped before did not.
        assert.deepEqual(run.summary?.nodes[id('ping')]?.ok_hosts, ['localhost']);
        assert.deepEqual(run.summary?.nodes[id('facts')]?.ok_hosts, ['localhost']);
        assert.equal(run.summary?.nodes[id('say-hello')], undefined);
        console.log(`  Step to the next pause, as the canvas shows it: ${stepMs} ms`);
      } finally {
        await vscode.commands.executeCommand('afd.run.togglePausePoint', HELLO, id('say-hello'));
      }
    }).timeout(300_000);
  },
);

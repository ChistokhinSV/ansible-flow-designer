// AFD-369 (ADR-0040 §8) inside VS Code, in the run environment (AFD_TEST_IMAGE, AFD_TEST_WSL or
// AFD_TEST_SSH; skipped without one): a tiny flow debugged through VS Code's debugger. h02 fails
// its first step: the session stops once on h02 (exception), Call Stack has a thread per host,
// the frames point at the step's key line, the scopes are the debugger's, evaluate answers and
// refuses a lookup in words, Retry runs the step again (it fails again: attempt 2), and Continue
// ends the run.
import * as assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as vscode from 'vscode';
import { closeAll, flowUri, runEnvironment, withTimeout } from './helpers';

const KEY = 'debug-fail';
const FIXTURE = join(__dirname, '../../../test/fixtures/debug/debug-fail.flow.yaml');

type Stopped = { reason: string; threadId: number; description?: string; text?: string };

(runEnvironment ? describe : describe.skip)(
  `AFD-369: debugging a flow in VS Code in ${runEnvironment ?? 'a run environment'}`,
  () => {
    const uri = flowUri(KEY);
    before(async () => {
      await vscode.workspace.fs.writeFile(uri, readFileSync(FIXTURE));
    });
    after(async () => {
      await closeAll();
      await vscode.workspace.fs
        .delete(vscode.Uri.joinPath(uri, '..'), { recursive: true })
        .then(undefined, () => undefined);
    });

    it('stops on the failed host; threads, frames, scopes, evaluate, Retry, Continue', async () => {
      const stops: Stopped[] = [];
      const output: string[] = [];
      const tracker = vscode.debug.registerDebugAdapterTrackerFactory('ansible-flow', {
        createDebugAdapterTracker: () => ({
          onDidSendMessage(m: { type: string; event?: string; body?: Record<string, unknown> }) {
            if (m.type === 'event' && m.event === 'stopped') stops.push(m.body as Stopped);
            if (m.type === 'event' && m.event === 'output') output.push(String(m.body?.output));
          },
        }),
      });
      let session: vscode.DebugSession | undefined;
      const ended = new Promise<void>((resolve) => {
        const sub = vscode.debug.onDidTerminateDebugSession((s) => {
          if (s.type !== 'ansible-flow') return;
          sub.dispose();
          resolve();
        });
      });
      const waitStop = async (n: number) => {
        const t0 = Date.now();
        while (stops.length < n) {
          if (Date.now() - t0 > 180_000)
            throw new Error(`no stop ${n}; console: ${output.join('').slice(-2000)}`);
          await new Promise((r) => setTimeout(r, 200));
        }
        return stops[n - 1] as Stopped;
      };
      try {
        const started = await vscode.debug.startDebugging(vscode.workspace.workspaceFolders?.[0], {
          type: 'ansible-flow',
          request: 'launch',
          name: 'Debug fail',
          flow: uri.fsPath,
          mode: 'check',
          inputs: { devices: ['h01', 'h02', 'h03'] },
        });
        assert.equal(started, true);
        session = vscode.debug.activeDebugSession;
        assert.equal(session?.type, 'ansible-flow');
        const s = session as vscode.DebugSession;

        const first = await waitStop(1);
        assert.equal(first.reason, 'exception', JSON.stringify(first));
        assert.equal(first.description, '1 host failed Check marker');
        const { threads } = (await s.customRequest('threads')) as {
          threads: { id: number; name: string }[];
        };
        assert.deepEqual(
          threads.map((t) => t.name),
          ['h02 · failed', 'h01 · waiting', 'h03 · waiting'],
        );
        assert.equal(first.threadId, threads[0]?.id);

        const { stackFrames } = (await s.customRequest('stackTrace', {
          threadId: first.threadId,
        })) as { stackFrames: { id: number; name: string; line: number }[] };
        const text = readFileSync(FIXTURE, 'utf8').split('\n');
        const keyLine = text.findIndex((l) => /^\s*key: check$/.test(l)) + 1;
        assert.equal(stackFrames[0]?.line, keyLine);
        assert.match(stackFrames[0]?.name ?? '', /^Check marker/);

        const { scopes } = (await s.customRequest('scopes', {
          frameId: stackFrames[0]?.id,
        })) as { scopes: { name: string; variablesReference: number; expensive: boolean }[] };
        assert.deepEqual(
          scopes.map((x) => [x.name, x.expensive]),
          [
            ['Step inputs (h02)', false],
            ['Host variables (h02)', false],
            ['Flow data', false],
            ['Facts', true],
          ],
        );
        const host = (await s.customRequest('variables', {
          variablesReference: scopes[1]?.variablesReference,
        })) as { variables: { name: string; value: string }[] };
        assert.equal(
          host.variables.find((v) => v.name === 'ansible_connection')?.value,
          '"local"',
          JSON.stringify(host.variables.slice(0, 20)),
        );

        const evaluated = (await s.customRequest('evaluate', {
          expression: '{{ inventory_hostname }}',
          frameId: stackFrames[0]?.id,
          context: 'repl',
        })) as { result: string };
        assert.equal(evaluated.result, '"h02"');
        const refused = (await s.customRequest('evaluate', {
          expression: "lookup('pipe', 'id')",
          frameId: stackFrames[0]?.id,
          context: 'repl',
        })) as { result: string };
        assert.match(refused.result, /^Refused: /);

        const info = (await s.customRequest('exceptionInfo', { threadId: first.threadId })) as {
          description: string;
          details: { message: string };
        };
        assert.equal(info.description, '1 host failed Check marker (attempt 1)');
        assert.match(info.details.message, /Changes on hosts are not undone/);

        // Retry (the designer's button and this command): the step runs again and fails again.
        const retried = await vscode.commands.executeCommand('afd.debug.retry', uri);
        assert.equal(retried, 'sent');
        const second = await waitStop(2);
        assert.equal(second.reason, 'exception');
        const again = (await s.customRequest('exceptionInfo', { threadId: second.threadId })) as {
          description: string;
        };
        assert.equal(again.description, '1 host failed Check marker (attempt 2)');

        // Continue: h02 goes to its failed end, the others on; the session ends.
        await s.customRequest('continue', { threadId: second.threadId });
        await withTimeout(ended, 180_000, 'the debug session to end');
        assert.match(output.join(''), /Debugging Debug fail/);
      } finally {
        tracker.dispose();
        if (vscode.debug.activeDebugSession?.type === 'ansible-flow')
          await vscode.debug.stopDebugging(vscode.debug.activeDebugSession);
      }
    }).timeout(420_000);
  },
);

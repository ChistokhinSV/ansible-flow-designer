// M3 acceptance inside VS Code: codegen on save, hand-edit protection, and (with AFD_TEST_IMAGE)
// the syntax check, a skeleton run and an audited real run in the configured Docker image.
import * as assert from 'node:assert/strict';
import { readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import * as vscode from 'vscode';
import { parse } from 'yaml';
import { optionA } from '../../src/core/engine/optionA';
import type { FlowDocument } from '../../src/core/flow/types';
import { closeAll, flowUri, openDesigner, runEnvironment, testApi, withTimeout } from './helpers';

const EDGE = flowUri('edge-baseline');
const OS = flowUri('os-upgrade');
const HELLO = flowUri('hello');
const docOf = (text: string) => parse(text) as FlowDocument;
const generatedOf = (flow: vscode.Uri, name: string) =>
  vscode.Uri.joinPath(flow, '..', 'generated', name);
const image = runEnvironment;

async function saveAndGenerate(uri: vscode.Uri) {
  const api = await testApi();
  await vscode.commands.executeCommand('workbench.action.files.save');
  const pending = api.savedCode(uri);
  assert.ok(pending, 'codegen started on save');
  return withTimeout(pending, 20_000, 'codegen on save');
}

describe('M3 acceptance: code generation', () => {
  afterEach(closeAll);

  it('saving a flow writes generated/ exactly as the engine produces it, once', async () => {
    // The moves below place one node without the positions the canvas would freeze: put the flows
    // back afterwards, so later suites do not start from a half-placed layout (AFD-23).
    const originals = [EDGE, OS].map((uri) => [uri, readFileSync(uri.fsPath, 'utf8')] as const);
    try {
      for (const uri of [EDGE, OS]) {
        const doc = await openDesigner(uri);
        // Make the document dirty with a layout-only change so the save really happens.
        const api = await testApi();
        const first = docOf(doc.getText()).nodes[1]?.id as string;
        await api.run(uri, { kind: 'moveNodes', positions: { [first]: { x: 12, y: 160 } } });
        const outcome = await saveAndGenerate(uri);
        assert.ok(outcome.ok, outcome.error);
        const expected = optionA.generate(docOf(doc.getText()), {
          source: uri.path.split('/').pop() as string,
        });
        for (const f of expected.files) {
          const path = generatedOf(uri, f.name).fsPath;
          assert.equal(readFileSync(path, 'utf8'), f.text, f.name);
        }
        const stamp = statSync(generatedOf(uri, expected.files[0]?.name ?? '').fsPath).mtimeMs;
        await api.run(uri, { kind: 'moveNodes', positions: { [first]: { x: 14, y: 160 } } });
        const again = await saveAndGenerate(uri);
        assert.deepEqual(again.written, [], 'layout-only change: generated code unchanged');
        assert.equal(
          statSync(generatedOf(uri, expected.files[0]?.name ?? '').fsPath).mtimeMs,
          stamp,
        );
        await closeAll();
      }
    } finally {
      await closeAll();
      for (const [uri, text] of originals) writeFileSync(uri.fsPath, text);
    }
  });

  it('Generate Code from the designer says what it came to, with no pop-up (AFD-46)', async () => {
    await openDesigner(EDGE);
    const said = await vscode.commands.executeCommand<{ level: string; text: string }>(
      'afd.code.generate',
      EDGE,
      { quiet: true },
    );
    assert.equal(said?.level, 'success');
    assert.match(
      said?.text ?? '',
      /^(Generated \d+ file\(s\) in .*generated|.*generated is up to date)/,
    );
  });

  it('never overwrites a generated file edited by hand on save', async () => {
    const doc = await openDesigner(EDGE);
    const api = await testApi();
    const target = generatedOf(EDGE, 'edge-baseline.yml').fsPath;
    const original = doc.getText();
    // Make sure the file exists and is current, then edit it by hand.
    const id = docOf(original).nodes.find((n) => n.key === 'validate')?.id as string;
    await api.run(EDGE, { kind: 'updateNode', id, patch: { title: 'Validate before' } });
    assert.ok((await saveAndGenerate(EDGE)).ok);
    const edited = readFileSync(target, 'utf8').replace('TODO: Save', 'Save');
    writeFileSync(target, edited);
    await api.run(EDGE, { kind: 'updateNode', id, patch: { title: 'Validate after' } });
    const outcome = await saveAndGenerate(EDGE);
    assert.deepEqual(
      outcome.kept.map((u) => u.fsPath),
      [vscode.Uri.file(target).fsPath],
    );
    assert.equal(readFileSync(target, 'utf8'), edited);
    // Runs refuse hand-edited code; give the next tests a clean file again.
    rmSync(target);
    await api.run(EDGE, { kind: 'updateNode', id, patch: { title: 'Validate' } });
    assert.ok((await saveAndGenerate(EDGE)).ok);
  });
});

(image ? describe : describe.skip)(`M3 acceptance: runs in ${image ?? 'a Docker image'}`, () => {
  afterEach(closeAll);

  it('the generated code passes the syntax check in the environment', async () => {
    await openDesigner(OS);
    const api = await testApi();
    const outcome = await withTimeout(api.syntaxCheck(OS), 240_000, 'syntax check');
    assert.ok(outcome.ok, outcome.message);
  }).timeout(300_000);

  it('run as skeleton maps every host back to the nodes it passed (check mode)', async () => {
    const doc = await openDesigner(EDGE);
    const api = await testApi();
    const run = await withTimeout(
      api.runFlow(EDGE, {
        mode: 'check',
        inputs: { devices: ['sw-edge-01', 'sw-edge-02'], site: 'lab' },
      }),
      240_000,
      'skeleton run',
    );
    if (run.state !== 'done') throw new Error(JSON.stringify(run));
    assert.equal(run.rc, 0);
    const flow = docOf(doc.getText());
    const id = (key: string) => flow.nodes.find((n) => n.key === key)?.id as string;
    const both = ['sw-edge-01', 'sw-edge-02'];
    for (const key of ['precheck', 'backup-config', 'push-baseline', 'validate'])
      assert.deepEqual(run.summary?.nodes[id(key)]?.ok_hosts, both, key);
    assert.deepEqual(run.summary?.outcome, {});
  }).timeout(300_000);

  it('AFD-74: the Hello sample runs as a skeleton on localhost, every step passing', async () => {
    const doc = await openDesigner(HELLO);
    const api = await testApi();
    const run = await withTimeout(
      api.runFlow(HELLO, { mode: 'check', inputs: { devices: ['localhost'] } }),
      240_000,
      'Hello skeleton run',
    );
    if (run.state !== 'done') throw new Error(JSON.stringify(run));
    assert.equal(run.rc, 0);
    const flow = docOf(doc.getText());
    for (const key of ['ping', 'facts', 'say-hello']) {
      const id = flow.nodes.find((n) => n.key === key)?.id as string;
      assert.deepEqual(run.summary?.nodes[id]?.ok_hosts, ['localhost'], key);
    }
    assert.deepEqual(run.summary?.outcome, {});
  }).timeout(300_000);

  it('AFD-81: with the designer open, the canvas follows the run, the terminal is its own, each host keeps its output', async () => {
    const doc = await openDesigner(HELLO);
    const api = await testApi();
    api.setMode(HELLO, 'run');
    const flow = docOf(doc.getText());
    const id = (key: string) => flow.nodes.find((n) => n.key === key)?.id as string;
    let finished = false;
    const states: string[][] = [];
    const going = api.runFlow(HELLO, { mode: 'check', inputs: { devices: ['localhost'] } });
    void going.finally(() => {
      finished = true;
    });
    while (!finished) {
      const nodes = (await api.inspect(HELLO)).run?.nodes ?? {};
      states.push([
        nodes[id('ping')] ?? '',
        nodes[id('facts')] ?? '',
        nodes[id('say-hello')] ?? '',
      ]);
      await new Promise((r) => setTimeout(r, 150));
    }
    const run = await withTimeout(going, 10_000, 'Hello skeleton run');
    if (run.state !== 'done') throw new Error(JSON.stringify(run));
    // Live: a step was running while the run went, and a step had its result before the run ended.
    assert.ok(
      states.some((row) => row.includes('running')),
      `no running step seen: ${JSON.stringify(states)}`,
    );
    assert.ok(
      states.some((row) => row.some((st) => st === 'ok')),
      `no result before the end: ${JSON.stringify(states)}`,
    );
    assert.equal(run.summary?.running, undefined);
    // The run's own terminal, found by its task's label.
    assert.match(api.runTerminal(HELLO) ?? '', /hello \(skeleton, check mode\)/);
    // Each host's output, from the kept events: the debug step's message.
    const out = await api.runOutput(HELLO, id('say-hello'), 'localhost');
    assert.equal(out.error, undefined, out.error);
    const hello = out.entries?.find((e) => e.out?.msg?.includes('Hello'));
    assert.ok(hello, JSON.stringify(out.entries));
    assert.equal(hello.status, 'ok');
  }).timeout(300_000);

  it('AFD-82: the launch dialog runs for real with no prompt, its token once, and not on other facts', async () => {
    await openDesigner(HELLO);
    const api = await testApi();
    const planned = await api.launchPlan(HELLO, 'real');
    if (!planned.ok) throw new Error(planned.error);
    const { plan } = planned;
    assert.deepEqual(
      plan.fields.map((f) => f.name),
      ['devices'],
    );
    // Shown for localhost: then Run runs for real with no input box and no modal (a modal would
    // hold this test until it times out).
    const go = await api.launchCheck(HELLO, plan.token, { devices: ['localhost'] });
    assert.equal(go.facts?.count, 1, JSON.stringify(go));
    const run = (await withTimeout(
      Promise.resolve(
        vscode.commands.executeCommand('afd.run.launched', HELLO, plan.token, {
          devices: ['localhost'],
        }),
      ),
      240_000,
      'Hello real run from the dialog',
    )) as { state: string; mode: string; rc?: number } | undefined;
    assert.equal(run?.state, 'done', JSON.stringify(run));
    assert.equal(run?.mode, 'real');
    assert.equal(run?.rc, 0);
    // The token was used: a second Run with it starts nothing.
    const again = await vscode.commands.executeCommand('afd.run.launched', HELLO, plan.token, {
      devices: ['localhost'],
    });
    assert.equal(again, undefined);
    // Shown for localhost, run for more: the inventory answers differently, nothing runs.
    const second = await api.launchPlan(HELLO, 'real');
    if (!second.ok) throw new Error(second.error);
    await api.launchCheck(HELLO, second.plan.token, { devices: ['localhost'] });
    const before = (await api.auditLog()).length;
    const changed = (await vscode.commands.executeCommand(
      'afd.run.launched',
      HELLO,
      second.plan.token,
      { devices: ['localhost', 'no-such-host-afd82'] },
    )) as { errorCode?: string } | undefined;
    assert.equal(changed?.errorCode, 'changed');
    assert.equal((await api.auditLog()).length, before);
  }).timeout(300_000);

  it('AFD-39: Stop Run ends a local run as stopped, not failed', async () => {
    const original = readFileSync(EDGE.fsPath, 'utf8');
    try {
      const doc = await openDesigner(EDGE);
      const api = await testApi();
      // A step that really waits, even in check mode, so there is a run to stop.
      const precheck = docOf(doc.getText()).nodes.find((n) => n.key === 'precheck')?.id as string;
      const bound = await api.run(EDGE, {
        kind: 'setBinding',
        id: precheck,
        impl: {
          kind: 'module',
          ref: 'ansible.builtin.command',
          params: { cmd: 'sleep 90' },
          keywords: { check_mode: false },
        },
      });
      assert.ok(bound.ok, bound.error);
      const running = api.runFlow(EDGE, {
        mode: 'check',
        inputs: { devices: ['sw-edge-01'], site: 'lab' },
      });
      let done: Awaited<typeof running> | undefined;
      void running.then((r) => {
        done = r;
      });
      const t0 = Date.now();
      while (!done && Date.now() - t0 < 200_000) {
        await new Promise((r) => setTimeout(r, 1_000));
        await vscode.commands.executeCommand('afd.run.stop', EDGE);
      }
      const run = await withTimeout(running, 30_000, 'stopped run');
      assert.equal(run.state, 'error', JSON.stringify(run));
      assert.equal(run.errorCode, 'cancelled');
      assert.equal(run.error, 'Stopped by the user');
      assert.ok(Date.now() - t0 < 90_000, 'stopped before the step ended by itself');
    } finally {
      writeFileSync(EDGE.fsPath, original);
      await vscode.commands.executeCommand('workbench.action.files.revert');
    }
  }).timeout(300_000);

  it('a real run is confirmed, audited, and the audit holds no input values', async () => {
    await openDesigner(EDGE);
    const api = await testApi();
    const run = await withTimeout(
      api.runFlow(EDGE, {
        mode: 'real',
        yes: true,
        inputs: { devices: ['sw-edge-03'], site: 'secret-site-x' },
      }),
      240_000,
      'real run',
    );
    if (run.state !== 'done') throw new Error(JSON.stringify(run));
    assert.equal(run.rc, 0);
    const log = await api.auditLog();
    const mine = log.filter((e) => e.run === run.id);
    assert.deepEqual(
      mine.map((e) => [e.event, e.mode ?? null]),
      [
        ['launch', 'real'],
        ['finish', null],
      ],
    );
    assert.equal(mine[0]?.hosts, 1);
    assert.ok(!JSON.stringify(mine).includes('secret-site-x'), 'no input values in the audit');
  }).timeout(300_000);
});

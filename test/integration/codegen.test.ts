// M3 acceptance inside VS Code: codegen on save, hand-edit protection, and (with AFD_TEST_IMAGE)
// the syntax check, a skeleton run and an audited real run in the configured Docker image.
import * as assert from 'node:assert/strict';
import { readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import * as vscode from 'vscode';
import { parse } from 'yaml';
import { optionA } from '../../src/core/engine/optionA';
import type { FlowDocument } from '../../src/core/flow/types';
import { closeAll, flowUri, openDesigner, testApi, withTimeout } from './helpers';

const EDGE = flowUri('edge-baseline');
const OS = flowUri('os-upgrade');
const docOf = (text: string) => parse(text) as FlowDocument;
const generatedOf = (flow: vscode.Uri, name: string) =>
  vscode.Uri.joinPath(flow, '..', 'generated', name);
const image = process.env.AFD_TEST_IMAGE;

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
      assert.equal(statSync(generatedOf(uri, expected.files[0]?.name ?? '').fsPath).mtimeMs, stamp);
      await closeAll();
    }
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

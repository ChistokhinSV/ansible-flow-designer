// M1 acceptance checks inside a real VS Code (handoff 06), against a throwaway Git workspace.
import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { parse } from 'yaml';
import { portsFor } from '../../src/core/flow/ports';
import type { FlowDocument } from '../../src/core/flow/types';
import {
  changedLines,
  closeAll,
  documentOf,
  flowUri,
  ids,
  openDesigner,
  sha,
  testApi,
  withTimeout,
} from './helpers';

const EDGE = flowUri('edge-baseline');
const OS = flowUri('os-upgrade');
const docOf = (text: string) => parse(text) as FlowDocument;
const nodeId = (text: string, key: string) =>
  docOf(text).nodes.find((n) => n.key === key)?.id as string;

async function runAndRender(
  uri: vscode.Uri,
  cmd: Parameters<Awaited<ReturnType<typeof testApi>>['run']>[1],
) {
  const api = await testApi();
  const doc = documentOf(uri);
  const outcome = await api.run(uri, cmd);
  assert.ok(outcome.ok, outcome.error);
  await withTimeout(api.rendered(uri, doc.version), 15_000, `render after ${cmd.kind}`);
  return outcome;
}

async function undoUntil(doc: vscode.TextDocument, text: string) {
  for (let i = 0; i < 10 && doc.getText() !== text; i++)
    await vscode.commands.executeCommand('undo');
}

describe('M1 acceptance: examples', () => {
  afterEach(closeAll);

  for (const [uri, nodes, edges] of [
    [EDGE, 8, 7],
    [OS, 15, 18],
  ] as const) {
    const name = uri.path.split('/').at(-1);
    it(`${name}: loads, renders and round-trips without changes (check 5)`, async () => {
      const api = await testApi();
      const before = sha(uri);
      const doc = await openDesigner(uri);
      assert.equal(doc.isDirty, false, 'opening must not dirty the document');
      const dom = await api.inspect(uri);
      assert.equal(dom.nodes.length, nodes);
      assert.equal(dom.edges, edges);
      assert.deepEqual(api.cspViolations(uri), []);
      assert.equal(
        api.diagnostics(uri).filter((d) => d.severity === vscode.DiagnosticSeverity.Error).length,
        0,
      );
      await vscode.commands.executeCommand('workbench.action.files.save');
      assert.equal(sha(uri), before, 'save must keep the bytes');
      await vscode.commands.executeCommand('vscode.openWith', uri, 'default');
      assert.equal(documentOf(uri).getText(), doc.getText());
    });

    it(`${name}: every node shows exactly its catalog ports (check 3)`, async () => {
      const api = await testApi();
      const doc = await openDesigner(uri);
      const dom = await api.inspect(uri);
      for (const node of docOf(doc.getText()).nodes) {
        const shown = dom.nodes.find((n) => n.id === node.id)?.ports;
        assert.deepEqual(
          shown,
          portsFor(node).map((p) => p.name),
          node.key,
        );
      }
    });

    it(`${name}: banner count equals the open-fail-port diagnostics (check 4)`, async () => {
      const api = await testApi();
      await openDesigner(uri);
      const dom = await api.inspect(uri);
      const open = api.diagnostics(uri).filter((d) => d.code === 'open-fail-port');
      assert.equal(dom.banner, 3);
      assert.equal(open.length, 3);
    });
  }
});

describe('M1 acceptance: editing', () => {
  afterEach(closeAll);

  it('rename keeps every ID and edge; undo restores the bytes (check 1)', async () => {
    const doc = await openDesigner(EDGE);
    const original = doc.getText();
    await runAndRender(EDGE, {
      kind: 'updateNode',
      id: nodeId(original, 'backup-config'),
      patch: { key: 'save-config', title: 'Save config' },
    });
    const after = doc.getText();
    assert.deepEqual(ids(after), ids(original));
    assert.deepEqual(docOf(after).edges, docOf(original).edges);
    for (const line of changedLines(original, after))
      assert.match(line.trim(), /^(key|title|from): /);
    await undoUntil(doc, original);
    assert.equal(doc.getText(), original, 'one undo restores the bytes');
  });

  it('create and move never change existing IDs; a move touches only the layout block (checks 1, 2)', async () => {
    const doc = await openDesigner(EDGE);
    const original = doc.getText();
    const created = await runAndRender(EDGE, {
      kind: 'addNode',
      type: 'task',
      title: 'Notify on-call',
      position: { x: 456, y: 520 },
      connectFrom: { node: nodeId(original, 'validate'), port: 'failed_hosts' },
    });
    const withNode = doc.getText();
    for (const id of ids(original)) assert.ok(withNode.includes(id), id);
    assert.ok(created.created && withNode.includes(created.created));

    await runAndRender(EDGE, {
      kind: 'moveNodes',
      positions: { [nodeId(original, 'start')]: { x: 300, y: 64 } },
    });
    const moved = doc.getText();
    const layoutAt = moved.indexOf('\nlayout:');
    const changed = changedLines(withNode, moved);
    assert.equal(changed.length, 1);
    assert.equal(changed[0]?.trim(), 'x: 300');
    assert.ok(moved.indexOf('x: 300') > layoutAt);
    await undoUntil(doc, original);
    assert.equal(doc.getText(), original);
  });

  it('the first move in a flow without layout inserts only a layout block', async () => {
    const doc = await openDesigner(OS);
    const original = doc.getText();
    await runAndRender(OS, {
      kind: 'moveNodes',
      positions: { [nodeId(original, 'start')]: { x: 0, y: 0 } },
    });
    const after = doc.getText();
    const start = after.indexOf('layout:\n');
    const end = after.indexOf('decisions:\n');
    assert.ok(start > 0 && end > start);
    assert.equal(after.slice(0, start) + after.slice(end), original);
    await undoUntil(doc, original);
  });

  it('flow.version bumps once per commit and never for layout-only saves (ADR-0006)', async () => {
    const doc = await openDesigner(EDGE);
    const original = doc.getText();
    const version = () => docOf(doc.getText()).flow.version;
    await runAndRender(EDGE, {
      kind: 'moveNodes',
      positions: { [nodeId(original, 'done')]: { x: 200, y: 640 } },
    });
    await vscode.commands.executeCommand('workbench.action.files.save');
    assert.equal(version(), 3, 'layout-only save');
    await runAndRender(EDGE, {
      kind: 'updateNode',
      id: nodeId(original, 'validate'),
      patch: { title: 'Validate config' },
    });
    await vscode.commands.executeCommand('workbench.action.files.save');
    assert.equal(version(), 4, 'first semantic save after the commit');
    await runAndRender(EDGE, {
      kind: 'updateNode',
      id: nodeId(original, 'validate'),
      patch: { title: 'Validate again' },
    });
    await vscode.commands.executeCommand('workbench.action.files.save');
    assert.equal(version(), 4, 'still the same commit');
    // Restore the committed bytes for the other tests.
    const edit = new vscode.WorkspaceEdit();
    edit.replace(EDGE, new vscode.Range(0, 0, doc.lineCount, 0), original);
    await vscode.workspace.applyEdit(edit);
    await doc.save();
  });

  it('YAML errors keep the last good model and refuse canvas edits', async () => {
    const api = await testApi();
    const doc = await openDesigner(EDGE);
    const original = doc.getText();
    const edit = new vscode.WorkspaceEdit();
    edit.insert(EDGE, new vscode.Position(0, 0), 'nodes: [\n');
    await vscode.workspace.applyEdit(edit);
    await withTimeout(api.rendered(EDGE, doc.version), 15_000, 'render of broken text');
    const outcome = await api.run(EDGE, {
      kind: 'moveNodes',
      positions: { [nodeId(original, 'start')]: { x: 1, y: 1 } },
    });
    assert.equal(outcome.ok, false);
    assert.ok(api.diagnostics(EDGE).some((d) => d.code === 'yaml'));
    const dom = await api.inspect(EDGE);
    assert.equal(dom.nodes.length, 8, 'last good model stays on the canvas');
    await undoUntil(doc, original);
    assert.equal(doc.getText(), original);
  });
});

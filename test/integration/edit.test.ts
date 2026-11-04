// AFD-18 acceptance inside VS Code: deleting a selection (nodes and a wire) is one edit that one
// undo restores, and Duplicate is one paste of a copy next to the original.
import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { parse } from 'yaml';
import { copyNodes } from '../../src/core/flow/clipboard';
import { planCommand } from '../../src/core/flow/commands';
import { createIdFactory } from '../../src/core/flow/ids';
import type { FlowDocument } from '../../src/core/flow/types';
import { closeAll, flowUri, openDesigner, testApi } from './helpers';

const EDGE = flowUri('edge-baseline');

describe('AFD-18 acceptance: one undo step per edit', () => {
  afterEach(closeAll);

  it('three nodes and a wire are deleted in one edit; one undo brings them back', async () => {
    const api = await testApi();
    const doc = await openDesigner(EDGE);
    const before = doc.getText();
    const flow = parse(before) as FlowDocument;
    const id = (key: string) => flow.nodes.find((n) => n.key === key)?.id as string;
    const wire = flow.edges.find((e) => e.from.node === id('start'))?.id as string;
    const version = doc.version;
    const outcome = await api.run(EDGE, {
      kind: 'deleteNodes',
      ids: [id('validate'), id('rollback'), id('backup-config')],
      edges: [wire],
    });
    assert.ok(outcome.ok, outcome.error);
    assert.equal(doc.version, version + 1, 'one edit');
    const after = parse(doc.getText()) as FlowDocument;
    assert.deepEqual(
      after.nodes
        .map((n) => n.key)
        .filter((k) => ['validate', 'rollback', 'backup-config'].includes(k)),
      [],
    );
    assert.ok(!after.edges.some((e) => e.id === wire));
    await vscode.commands.executeCommand('undo');
    assert.equal(doc.getText(), before);
  });

  it('AFD-65: a note on a node is one edit, drawn, follows the node; undo removes it', async () => {
    const api = await testApi();
    const doc = await openDesigner(EDGE);
    assert.ok((await api.run(EDGE, { kind: 'upgradeFormat' })).ok);
    const before = doc.getText();
    const flow = parse(before) as FlowDocument;
    const precheck = flow.nodes.find((n) => n.key === 'precheck')?.id as string;
    const version = doc.version;
    const added = await api.run(EDGE, {
      kind: 'addAnnotation',
      annotation: { text: 'Read-only: **safe** to rerun', on: precheck, x: 232, y: 0 },
    });
    assert.ok(added.ok, added.error);
    assert.equal(doc.version, version + 1, 'one edit');
    let dom = await api.inspect(EDGE);
    for (let i = 0; i < 50 && dom.annotations !== 1; i++) {
      await new Promise((r) => setTimeout(r, 100));
      dom = await api.inspect(EDGE);
    }
    assert.equal(dom.annotations, 1, 'drawn on the canvas');
    assert.equal(dom.nodes.length, flow.nodes.length, 'node counts stay node-only');
    // Moving the node keeps the note's offset: it follows.
    assert.ok(
      (await api.run(EDGE, { kind: 'moveNodes', positions: { [precheck]: { x: 0, y: 0 } } })).ok,
    );
    const note = (parse(doc.getText()) as FlowDocument).annotations?.[0];
    assert.deepEqual([note?.on, note?.x, note?.y], [precheck, 232, 0]);
    await vscode.commands.executeCommand('undo');
    await vscode.commands.executeCommand('undo');
    assert.equal(doc.getText(), before);
  });

  it('Duplicate is one paste of a copy at +40, +40; one undo removes it', async () => {
    const api = await testApi();
    const doc = await openDesigner(EDGE);
    const before = doc.getText();
    const flow = parse(before) as FlowDocument;
    const node = flow.nodes.find((n) => n.key === 'validate');
    const outcome = await api.run(EDGE, {
      kind: 'pasteNodes',
      text: copyNodes(flow, [node?.id as string]),
      level: 'root',
    });
    assert.ok(outcome.ok, outcome.error);
    const after = parse(doc.getText()) as FlowDocument;
    const copy = after.nodes.find((n) => n.key === 'validate-2');
    const was = flow.layout?.[node?.id as string] as { x: number; y: number };
    assert.deepEqual(after.layout?.[copy?.id as string], { x: was.x + 40, y: was.y + 40 });
    await vscode.commands.executeCommand('undo');
    assert.equal(doc.getText(), before);
  });

  it('Upgrade Flow Format: nothing written on open, one edit, one undo back to the same bytes (AFD-49)', async () => {
    const doc = await openDesigner(EDGE);
    const before = doc.getText();
    assert.match(before, /^schema_version: 1$/m);
    assert.ok(!doc.isDirty, 'opening a format 1 flow writes nothing');
    const version = doc.version;
    const outcome = await vscode.commands.executeCommand<{ ok: boolean; error?: string }>(
      'afd.flow.upgradeFormat',
      EDGE,
    );
    assert.ok(outcome?.ok, outcome?.error);
    assert.equal(doc.version, version + 1, 'one edit');
    // What the core upgrade makes of it (the statuses follow their content since AFD-50).
    const upgraded = planCommand(before, { kind: 'upgradeFormat' }, { newId: createIdFactory() });
    assert.equal(doc.getText(), upgraded.text);
    assert.match(doc.getText(), /^schema_version: 2$/m);
    await vscode.commands.executeCommand('undo');
    assert.equal(doc.getText(), before);
  });
});

describe('AFD-85: edits made outside the designer', () => {
  afterEach(closeAll);

  it('an edit written to disk is marked; the designer’s own edit is not', async () => {
    const { readFileSync, writeFileSync } = await import('node:fs');
    const original = readFileSync(EDGE.fsPath, 'utf8');
    try {
      const doc = await openDesigner(EDGE);
      const api = await testApi();
      const flow = parse(doc.getText()) as FlowDocument;
      const precheck = flow.nodes.find((n) => n.key === 'precheck');
      assert.ok(precheck);
      assert.equal(api.outsideMarks(EDGE), undefined);
      // An agent rewrites the file on disk: VS Code reloads the clean document.
      writeFileSync(
        EDGE.fsPath,
        original.replace(`title: ${precheck.title}`, 'title: Pre-checks from an agent'),
      );
      for (let i = 0; i < 100 && !api.outsideMarks(EDGE); i++)
        await new Promise((r) => setTimeout(r, 100));
      assert.deepEqual(api.outsideMarks(EDGE)?.nodes, [precheck.id]);
      // The designer's own edit adds nothing.
      const moved = await api.run(EDGE, {
        kind: 'moveNodes',
        positions: { [precheck.id]: { x: 10, y: 10 } },
      });
      assert.ok(moved.ok, moved.error);
      await new Promise((r) => setTimeout(r, 500));
      assert.deepEqual(api.outsideMarks(EDGE)?.nodes, [precheck.id]);
    } finally {
      await closeAll();
      writeFileSync(EDGE.fsPath, original);
    }
  });
});

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

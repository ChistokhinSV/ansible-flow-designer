// AFD-18 acceptance inside VS Code: deleting a selection (nodes and a wire) is one edit that one
// undo restores, and Duplicate is one paste of a copy next to the original.
import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { parse, parseDocument } from 'yaml';
import { copyNodes } from '../../src/core/flow/clipboard';
import { planCommand } from '../../src/core/flow/commands';
import { createIdFactory } from '../../src/core/flow/ids';
import { diffFlows } from '../../src/core/flow/semanticDiff';
import type { FlowDocument } from '../../src/core/flow/types';
import { changeLines } from '../../src/core/view/outsideChanges';
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

  it('AFD-153: commands sent together run one after the other; none is rejected', async () => {
    const api = await testApi();
    const doc = await openDesigner(EDGE);
    const before = doc.getText();
    const version = doc.version;
    // Before AFD-153 the second planned against the old text and VS Code rejected its edit.
    const outcomes = await Promise.all(
      ['Burst one', 'Burst two', 'Burst three'].map((title) =>
        api.run(EDGE, { kind: 'addNode', type: 'task', title }),
      ),
    );
    for (const o of outcomes) assert.ok(o.ok, o.error);
    assert.equal(doc.version, version + 3, 'three edits');
    const titles = (parse(doc.getText()) as FlowDocument).nodes.map((n) => n.title);
    for (const t of ['Burst one', 'Burst two', 'Burst three']) assert.ok(titles.includes(t), t);
    for (let i = 0; i < 3; i++) await vscode.commands.executeCommand('undo');
    assert.equal(doc.getText(), before);
  });

  it('AFD-157: a designer hidden behind another tab keeps the level it had open', async () => {
    const api = await testApi();
    const OS = flowUri('os-upgrade');
    await openDesigner(OS);
    const flow = parse((await vscode.workspace.openTextDocument(OS)).getText()) as FlowDocument;
    const sub = flow.nodes.find((n) => n.type === 'subflow' && n.subflow?.nodes?.length);
    assert.ok(sub, 'os-upgrade has a subflow with steps');
    api.openLevel(OS, sub.id);
    for (let i = 0; i < 50 && (await api.inspect(OS)).level !== sub.id; i++)
      await new Promise((r) => setTimeout(r, 100));
    assert.equal((await api.inspect(OS)).level, sub.id);
    // Another editor in the same group hides the designer; showing it again must not reload it.
    const other = await vscode.workspace.openTextDocument({
      content: 'hidden',
      language: 'plaintext',
    });
    await vscode.window.showTextDocument(other, { preview: false });
    await new Promise((r) => setTimeout(r, 500));
    await vscode.commands.executeCommand('workbench.action.previousEditor');
    await new Promise((r) => setTimeout(r, 500));
    assert.equal((await api.inspect(OS)).level, sub.id, 'the open subflow is still open');
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
    // AFD-92: what an earlier test left shown would come back as marks.
    await (await testApi()).forgetShown();
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

describe('AFD-92: edits made while the flow was closed', () => {
  afterEach(closeAll);

  it('a change made with the designer closed is marked when it opens again; none when nothing changed', async () => {
    const { readFileSync, writeFileSync } = await import('node:fs');
    const original = readFileSync(EDGE.fsPath, 'utf8');
    const api = await testApi();
    await api.forgetShown();
    const wait = async (test: () => Promise<boolean> | boolean, what: string) => {
      for (let i = 0; i < 100; i++) {
        if (await test()) return;
        await new Promise((r) => setTimeout(r, 100));
      }
      assert.fail(`timed out: ${what}`);
    };
    try {
      const doc = await openDesigner(EDGE);
      const flow = parse(doc.getText()) as FlowDocument;
      const precheck = flow.nodes.find((n) => n.key === 'precheck');
      assert.ok(precheck);
      // The designer closes: it keeps the flow as it showed it.
      await closeAll();
      await wait(async () => (await api.shownFlow(EDGE))?.text === original, 'remembered');
      // An agent edits the closed flow.
      writeFileSync(
        EDGE.fsPath,
        original.replace(`title: ${precheck.title}`, 'title: Pre-checks from an agent'),
      );
      await openDesigner(EDGE);
      await wait(() => !!api.outsideMarks(EDGE), 'marks');
      assert.deepEqual(api.outsideMarks(EDGE)?.nodes, [precheck.id]);
      assert.equal(api.outsideMarks(EDGE)?.closed, true);
      // Clear: the flow as it is now is what the designer showed; opening again marks nothing.
      await api.clearOutside(EDGE);
      await closeAll();
      const again = await openDesigner(EDGE);
      await new Promise((r) => setTimeout(r, 500));
      assert.equal(api.outsideMarks(EDGE), undefined);
      // The designer's own edit and save (with its version bump) are not outside edits either.
      const moved = await api.run(EDGE, {
        kind: 'moveNodes',
        positions: { [precheck.id]: { x: 40, y: 40 } },
      });
      assert.ok(moved.ok, moved.error);
      await again.save();
      await new Promise((r) => setTimeout(r, 500));
      assert.equal(api.outsideMarks(EDGE), undefined);
      await closeAll();
      await openDesigner(EDGE);
      await new Promise((r) => setTimeout(r, 500));
      assert.equal(api.outsideMarks(EDGE), undefined);
    } finally {
      await closeAll();
      writeFileSync(EDGE.fsPath, original);
      await api.forgetShown();
    }
  });
});

describe('AFD-104: what changed outside, in words', () => {
  afterEach(closeAll);

  it('a closed flow changed by a colleague: the marks say what changed, the Changes lens compares with the flow as last shown', async () => {
    const { readFileSync, writeFileSync } = await import('node:fs');
    const original = readFileSync(EDGE.fsPath, 'utf8');
    const api = await testApi();
    await api.forgetShown();
    const wait = async (test: () => Promise<boolean> | boolean, what: string) => {
      for (let i = 0; i < 100; i++) {
        if (await test()) return;
        await new Promise((r) => setTimeout(r, 100));
      }
      assert.fail(`timed out: ${what}`);
    };
    try {
      const doc = await openDesigner(EDGE);
      const flow = parse(doc.getText()) as FlowDocument;
      const at = (key: string) => flow.nodes.findIndex((n) => n.key === key);
      await closeAll();
      await wait(async () => (await api.shownFlow(EDGE))?.text === original, 'remembered');
      // A colleague's change arrives while the designer is closed (a pull rewrites the file).
      const yaml = parseDocument(original);
      yaml.setIn(['nodes', at('precheck'), 'title'], 'Pre-checks from a colleague');
      yaml.setIn(['nodes', at('validate'), 'settings'], { retries: 3 });
      writeFileSync(EDGE.fsPath, yaml.toString());
      await openDesigner(EDGE);
      await wait(() => !!api.outsideMarks(EDGE), 'marks');
      const marks = api.outsideMarks(EDGE);
      assert.ok(marks);
      assert.deepEqual(
        changeLines(marks).map((l) => l.text),
        [
          'Renamed Pre-checks to Pre-checks from a colleague',
          'Validate: settings changed (retries)',
        ],
      );
      // The Changes lens compares with the flow as the designer last showed it, not with HEAD.
      api.setLens(EDGE, 'changes');
      await wait(() => api.lensFacts(EDGE).compare?.state === 'ready', 'lens base');
      const compare = api.lensFacts(EDGE).compare;
      assert.equal(compare?.ref, 'outside');
      assert.match(compare?.label ?? '', /^the flow as you last had it open \(/);
      const now = parse(readFileSync(EDGE.fsPath, 'utf8')) as FlowDocument;
      assert.deepEqual(
        diffFlows(compare?.base as FlowDocument, now)
          .nodes.map((n) => n.key)
          .sort(),
        ['precheck', 'validate'],
      );
      // Clear: the marks go, and the lens goes back to Git.
      await api.clearOutside(EDGE);
      await wait(() => api.lensFacts(EDGE).compare?.ref === 'HEAD', 'back to HEAD');
      api.setLens(EDGE, null);
    } finally {
      await closeAll();
      writeFileSync(EDGE.fsPath, original);
      await api.forgetShown();
    }
  });
});

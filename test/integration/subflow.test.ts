// M4 acceptance inside VS Code (AFD-6): drill-down with the boundary frame, editing inside a
// subflow as single undo steps, boundary validation in the Problems panel, and generated code for
// a subflow created from scratch.
import * as assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import * as vscode from 'vscode';
import { parse } from 'yaml';
import type { FlowCommand } from '../../src/core/flow/commands';
import { buildModel } from '../../src/core/flow/model';
import type { FlowDocument } from '../../src/core/flow/types';
import type { DomSummary } from '../../src/core/protocol';
import { closeAll, documentOf, flowUri, ids, openDesigner, testApi, withTimeout } from './helpers';

const OS = flowUri('os-upgrade');
const EDGE = flowUri('edge-baseline');
const docOf = (text: string) => parse(text) as FlowDocument;
const nodeId = (text: string, key: string) =>
  [...buildModel(docOf(text)).nodes.values()].find((e) => e.node.key === key)?.node.id as string;

async function runAndRender(uri: vscode.Uri, cmd: FlowCommand) {
  const api = await testApi();
  const outcome = await api.run(uri, cmd);
  assert.ok(outcome.ok, `${cmd.kind}: ${outcome.error}`);
  await withTimeout(api.rendered(uri, documentOf(uri).version), 15_000, `render after ${cmd.kind}`);
  return outcome;
}

async function undoTo(doc: vscode.TextDocument, text: string) {
  await vscode.commands.executeCommand('undo');
  assert.equal(doc.getText(), text, 'one undo restores the bytes');
}

/** The canvas summary once it shows `level` (level switches render asynchronously). */
async function inspectLevel(
  uri: vscode.Uri,
  level: string,
  ready: (d: DomSummary) => boolean = () => true,
): Promise<DomSummary> {
  const api = await testApi();
  for (let i = 0; i < 50; i++) {
    const dom = await api.inspect(uri);
    if (dom.level === level && (level === 'root' || dom.frame) && ready(dom)) return dom;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`the canvas never showed level ${level}`);
}

describe('M4 acceptance: subflows', () => {
  afterEach(closeAll);

  it('drill-down shows the inner steps in a frame with the parent ports (check 1)', async () => {
    const doc = await openDesigner(OS);
    const api = await testApi();
    const up = nodeId(doc.getText(), 'upgrade-os');
    api.openLevel(OS, up);
    // Wires appear once React Flow has measured the frame's handles.
    const inside = await inspectLevel(OS, up, (d) => (d.frame?.wires ?? 0) >= 4);
    assert.equal(inside.nodes.length, 6);
    assert.deepEqual(inside.frame?.ports, ['in', 'ok_hosts', 'failed_hosts', 'unreachable']);
    assert.equal(inside.frame?.wires, 4, 'entry + three exits');
    api.openLevel(OS, 'root');
    const top = await inspectLevel(OS, 'root');
    assert.equal(top.nodes.length, 15);
    assert.equal(top.frame, null);
  });

  it('edits inside a subflow are one undo step each and keep every ID (check 2)', async () => {
    const doc = await openDesigner(OS);
    const original = doc.getText();
    const up = nodeId(original, 'upgrade-os');
    const boot = nodeId(original, 'set-boot-variable');
    const wait = nodeId(original, 'wait-for-ssh');
    const verify = nodeId(original, 'verify-version');
    (await testApi()).openLevel(OS, up);
    await inspectLevel(OS, up);
    const steps: FlowCommand[] = [
      {
        kind: 'addNode',
        parent: up,
        type: 'task',
        title: 'Save config',
        position: { x: 40, y: 900 },
      },
      {
        kind: 'connectBoundary',
        subflow: up,
        from: { node: boot, port: 'unchanged' },
        port: 'unchanged',
      },
      {
        kind: 'setExitReason',
        subflow: up,
        from: { node: wait, port: 'unreachable' },
        port: 'unreachable',
        reason: 'SSH timeout',
      },
      { kind: 'setBoundaryIn', subflow: up, node: wait },
      {
        kind: 'disconnectBoundary',
        subflow: up,
        from: { node: verify, port: 'ok_hosts' },
        port: 'ok_hosts',
      },
      { kind: 'moveNodes', positions: { [boot]: { x: 300, y: 300 } } },
    ];
    for (const cmd of steps) {
      const before = doc.getText();
      await runAndRender(OS, cmd);
      for (const id of ids(before)) assert.ok(doc.getText().includes(id), `${cmd.kind} kept ${id}`);
      await undoTo(doc, before);
    }
    assert.equal(doc.getText(), original);
  });

  it('boundary problems reach the Problems panel (check 3)', async () => {
    const doc = await openDesigner(OS);
    const original = doc.getText();
    const up = nodeId(original, 'upgrade-os');
    const verify = nodeId(original, 'verify-version');
    const api = await testApi();
    const codes = () => api.diagnostics(OS).map((d) => String(d.code));
    assert.ok(!codes().some((c) => /^(boundary|inner-exit)/.test(c)), codes().join());
    await runAndRender(OS, {
      kind: 'disconnectBoundary',
      subflow: up,
      from: { node: verify, port: 'ok_hosts' },
      port: 'ok_hosts',
    });
    assert.ok(codes().includes('boundary-port-unfed'), codes().join());
    assert.ok(codes().includes('inner-exit-unmapped'), codes().join());
    await undoTo(doc, original);
  });

  it('the first step of an empty subflow creates its level; saving generates it (check 5)', async () => {
    const doc = await openDesigner(EDGE);
    const original = doc.getText();
    const push = nodeId(original, 'push-baseline');
    const api = await testApi();
    const added = await runAndRender(EDGE, {
      kind: 'addNode',
      parent: push,
      type: 'task',
      title: 'Render config',
      position: { x: 0, y: 0 },
    });
    const body = docOf(doc.getText()).nodes.find((n) => n.id === push)?.subflow;
    assert.deepEqual(body?.boundary, { in: added.created });
    api.openLevel(EDGE, push);
    const inside = await inspectLevel(EDGE, push, (d) => (d.frame?.wires ?? 0) >= 1);
    assert.equal(inside.nodes.length, 1);
    assert.equal(inside.frame?.wires, 1, 'the entry');

    await vscode.commands.executeCommand('workbench.action.files.save');
    const outcome = await withTimeout(
      api.savedCode(EDGE) as Promise<{ ok: boolean }>,
      20_000,
      'codegen',
    );
    assert.ok(outcome.ok);
    const level = vscode.Uri.joinPath(EDGE, '..', 'generated', 'edge-baseline.push-baseline.yml');
    assert.ok(existsSync(level.fsPath), 'level file written');
    assert.match(readFileSync(level.fsPath, 'utf8'), /\[render-config\] Render config/);
    const root = vscode.Uri.joinPath(EDGE, '..', 'generated', 'edge-baseline.yml');
    assert.match(
      readFileSync(root.fsPath, 'utf8'),
      /import_playbook: edge-baseline\.push-baseline\.yml/,
    );

    // Restore the committed flow for the other suites; the stale level file is removed on save.
    const edit = new vscode.WorkspaceEdit();
    edit.replace(EDGE, new vscode.Range(0, 0, doc.lineCount, 0), original);
    await vscode.workspace.applyEdit(edit);
    await doc.save();
    await withTimeout(api.savedCode(EDGE) as Promise<unknown>, 20_000, 'codegen after restore');
    assert.ok(!existsSync(level.fsPath), 'stale level file removed');
  });
});

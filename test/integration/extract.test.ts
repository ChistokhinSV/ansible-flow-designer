// AFD-7 acceptance inside VS Code: Extract into subflow on os-upgrade is one edit that keeps every
// ID, the canvas shows the new subflow and its inner level, and one undo restores the bytes.
import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { parse } from 'yaml';
import type { FlowDocument } from '../../src/core/flow/types';
import type { DomSummary } from '../../src/core/protocol';
import { closeAll, flowUri, ids, openDesigner, testApi } from './helpers';

const OS = flowUri('os-upgrade');

async function inspectLevel(
  level: string,
  ready: (d: DomSummary) => boolean = () => true,
): Promise<DomSummary> {
  const api = await testApi();
  for (let i = 0; i < 50; i++) {
    const dom = await api.inspect(OS);
    if (dom.level === level && (level === 'root' || dom.frame) && ready(dom)) return dom;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`the canvas never showed level ${level}`);
}

describe('AFD-7 acceptance: extract into a subflow', () => {
  afterEach(closeAll);

  it('one edit keeps every ID; the new level shows the group; one undo restores the bytes', async () => {
    const api = await testApi();
    const doc = await openDesigner(OS);
    const before = doc.getText();
    const flow = parse(before) as FlowDocument;
    const id = (key: string) => flow.nodes.find((n) => n.key === key)?.id as string;
    const top = await inspectLevel('root');
    assert.equal(top.nodes.length, 15);

    const outcome = await api.run(OS, {
      kind: 'extractSubflow',
      nodes: [id('backup-config'), id('drain-traffic')],
      title: 'Prepare',
    });
    assert.ok(outcome.ok, outcome.error);
    const after = doc.getText();
    const kept = new Set(ids(after));
    for (const old of ids(before)) assert.ok(kept.has(old), old);
    const sub = (parse(after) as FlowDocument).nodes.find((n) => n.key === 'prepare');
    assert.equal(sub?.type, 'subflow');
    assert.deepEqual(
      sub?.subflow?.nodes?.map((n) => n.key),
      ['backup-config', 'drain-traffic'],
    );

    const root = await inspectLevel('root', (d) => d.nodes.length === 14);
    assert.equal(root.nodes.length, 14);
    api.openLevel(OS, sub?.id as string);
    // Entry plus the ok_hosts and failed_hosts exits.
    const inside = await inspectLevel(sub?.id as string, (d) => (d.frame?.wires ?? 0) >= 3);
    assert.equal(inside.nodes.length, 2);
    assert.equal(inside.frame?.wires, 3);
    api.openLevel(OS, 'root');

    await vscode.commands.executeCommand('undo');
    assert.equal(doc.getText(), before, 'one undo restores the bytes');
  });

  it('a selection with two ways in is refused and nothing changes', async () => {
    const api = await testApi();
    const doc = await openDesigner(OS);
    const before = doc.getText();
    const flow = parse(before) as FlowDocument;
    const id = (key: string) => flow.nodes.find((n) => n.key === key)?.id as string;
    const outcome = await api.run(OS, {
      kind: 'extractSubflow',
      nodes: [id('rollback'), id('notify-on-call')],
      title: 'Handlers',
    });
    assert.equal(outcome.ok, false);
    assert.match(outcome.error ?? '', /one way in|not connected/);
    assert.equal(doc.getText(), before);
    assert.equal(doc.isDirty, false);
  });
});

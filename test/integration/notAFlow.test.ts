// AFD-16 acceptance inside VS Code: an empty *.flow.yaml opens in the designer without a problem
// and becomes a flow named after the file in one edit (one undo empties it again); a file with
// content is reported and never overwritten.
import * as assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as vscode from 'vscode';
import { parse } from 'yaml';
import type { FlowDocument } from '../../src/core/flow/types';
import { closeAll, openDesigner, testApi } from './helpers';

const root = () => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath as string;
const dir = () => join(root(), 'flows', 'scratch-afd16');

function file(name: string, text: string): vscode.Uri {
  mkdirSync(dir(), { recursive: true });
  const path = join(dir(), name);
  writeFileSync(path, text);
  return vscode.Uri.file(path);
}

describe('AFD-16 acceptance: a *.flow.yaml that is not a flow', () => {
  afterEach(closeAll);
  after(() => rmSync(dir(), { recursive: true, force: true }));

  it('empty: no problem reported; Create a flow here is one edit, one undo empties it', async () => {
    const api = await testApi();
    const uri = file('edge-checks.flow.yaml', '');
    const doc = await openDesigner(uri);
    assert.deepEqual(api.diagnostics(uri), []);
    const outcome = await api.initFlow(uri);
    assert.ok(outcome.ok, outcome.error);
    const flow = parse(doc.getText()) as FlowDocument;
    assert.equal(flow.flow.key, 'edge-checks');
    assert.equal(flow.flow.name, 'Edge checks');
    assert.deepEqual(
      flow.nodes.map((n) => n.type),
      ['start', 'end'],
    );
    assert.equal(flow.flow.inputs?.devices?.targets, true);
    await api.rendered(uri, doc.version);
    assert.equal(
      api.diagnostics(uri).filter((d) => d.severity === vscode.DiagnosticSeverity.Error).length,
      0,
    );
    await vscode.commands.executeCommand('undo');
    assert.equal(doc.getText(), '');
  });

  it('comments only: they stay on top of the new flow', async () => {
    const api = await testApi();
    const uri = file('commented.flow.yaml', '# Owner: netops\n');
    const doc = await openDesigner(uri);
    assert.ok((await api.initFlow(uri)).ok);
    // New flows are written in the current format (AFD-49).
    assert.ok(doc.getText().startsWith('# Owner: netops\nschema_version: 2\n'));
  });

  it('with content: reported, and Create a flow here is refused', async () => {
    const api = await testApi();
    const text = 'flow: [not closed\n';
    const uri = file('broken.flow.yaml', text);
    const doc = await openDesigner(uri);
    assert.equal(api.diagnostics(uri).length, 1);
    const outcome = await api.initFlow(uri);
    assert.equal(outcome.ok, false);
    assert.equal(doc.getText(), text);
  });
});

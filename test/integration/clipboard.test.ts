// AFD-17 acceptance inside VS Code: nodes go to the system clipboard as YAML text, the text is a
// snippet a text editor keeps, and Paste puts them on another flow or a subflow level in one edit
// that one undo takes back. The user's clipboard is restored.
// Ctrl+C / Ctrl+V reach the canvas as the page's copy/paste events (VS Code runs execCommand in
// the focused webview); Chromium allows that only after a real key press, which a test cannot
// make, so the events are covered by the webview tests and the palette commands here.
import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { parse } from 'yaml';
import { CLIP_HEADER } from '../../src/core/flow/clipboard';
import type { FlowDocument } from '../../src/core/flow/types';
import { closeAll, flowUri, openDesigner, testApi } from './helpers';

const EDGE = flowUri('edge-baseline');
const OS = flowUri('os-upgrade');

async function clipboardWith(pred: (text: string) => boolean, what: string): Promise<string> {
  for (let i = 0; i < 50; i++) {
    const text = await vscode.env.clipboard.readText();
    if (pred(text)) return text;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`the clipboard never held ${what}`);
}

async function changed(doc: vscode.TextDocument, before: string): Promise<string> {
  for (let i = 0; i < 50; i++) {
    if (doc.getText() !== before) return doc.getText();
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('the paste never reached the document');
}

/** Selects a node and waits until the canvas shows it selected. */
async function selectNode(uri: vscode.Uri, key: string): Promise<string> {
  const api = await testApi();
  const flow = parse((await vscode.workspace.openTextDocument(uri)).getText()) as FlowDocument;
  const id = flow.nodes.find((n) => n.key === key)?.id as string;
  api.reveal(uri, id);
  await new Promise((r) => setTimeout(r, 300));
  return id;
}

describe('AFD-17 acceptance: copy and paste nodes', () => {
  let saved = '';
  before(async () => {
    saved = await vscode.env.clipboard.readText();
  });
  after(async () => {
    await vscode.env.clipboard.writeText(saved);
  });
  afterEach(closeAll);

  it('Copy Nodes: the selection as YAML text, a snippet a text editor keeps as it is', async () => {
    await openDesigner(EDGE);
    await vscode.env.clipboard.writeText('');
    await selectNode(EDGE, 'backup-config');
    await vscode.commands.executeCommand('afd.copyNodes');
    const text = await clipboardWith((t) => t.startsWith(CLIP_HEADER), 'copied nodes');
    const clip = parse(text) as Pick<FlowDocument, 'nodes' | 'decisions'>;
    assert.deepEqual(
      clip.nodes.map((n) => n.key),
      ['backup-config'],
    );
    assert.equal(clip.decisions?.[0]?.kind, 'open_on_purpose');
    // Kept in a text file, the snippet is plain YAML that the text editor does not change.
    const snippet = await vscode.workspace.openTextDocument({ content: text, language: 'yaml' });
    assert.equal(snippet.getText(), text);
  });

  it('Paste Nodes on another flow: one edit with new IDs and keys, one undo restores the bytes', async () => {
    await openDesigner(EDGE);
    await selectNode(EDGE, 'backup-config');
    await vscode.env.clipboard.writeText('');
    await vscode.commands.executeCommand('afd.copyNodes');
    await clipboardWith((t) => t.startsWith(CLIP_HEADER), 'copied nodes');
    await closeAll();

    const api = await testApi();
    const doc = await openDesigner(OS);
    const before = doc.getText();
    await vscode.commands.executeCommand('afd.pasteNodes');
    const after = parse(await changed(doc, before)) as FlowDocument;
    const pasted = after.nodes.at(-1);
    // os-upgrade has a backup-config of its own.
    assert.equal(pasted?.key, 'backup-config-2');
    assert.ok(!(parse(before) as FlowDocument).nodes.some((n) => n.id === pasted?.id));
    assert.ok(after.layout?.[pasted?.id as string], 'placed on the canvas');
    assert.ok(after.decisions?.some((d) => d.node === pasted?.id));
    await api.rendered(OS, doc.version);
    assert.equal(
      api.diagnostics(OS).filter((d) => d.severity === vscode.DiagnosticSeverity.Error).length,
      0,
    );
    await vscode.commands.executeCommand('undo');
    assert.equal(doc.getText(), before);
  });

  it('a snippet from a text file pastes into the open subflow level', async () => {
    const api = await testApi();
    const doc = await openDesigner(OS);
    const before = doc.getText();
    const upgrade = (parse(before) as FlowDocument).nodes.find((n) => n.key === 'upgrade-os');
    api.openLevel(OS, upgrade?.id as string);
    await new Promise((r) => setTimeout(r, 300));
    await vscode.env.clipboard.writeText(
      '# kept in notes.yaml\n- type: task\n  title: Check free flash\n  status: tested\n',
    );
    await vscode.commands.executeCommand('afd.pasteNodes');
    const after = parse(await changed(doc, before)) as FlowDocument;
    const inner = after.nodes.find((n) => n.key === 'upgrade-os')?.subflow?.nodes ?? [];
    assert.deepEqual(
      [inner.at(-1)?.key, inner.at(-1)?.status],
      ['check-free-flash', 'implemented'],
    );
    assert.equal(after.nodes.length, (parse(before) as FlowDocument).nodes.length);
    await vscode.commands.executeCommand('undo');
    assert.equal(doc.getText(), before);
  });
});

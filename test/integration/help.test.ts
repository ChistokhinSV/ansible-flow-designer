// AFD-22 inside VS Code: Open Sample Flow copies a bundled sample and opens it in the designer
// (and never overwrites one already there), Open User Guide shows a guide page in the Markdown
// preview (and nothing outside docs/guide), Get Started opens the walkthrough, and designer edits
// set the walkthrough's tour keys.
import * as assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as vscode from 'vscode';
import { parse } from 'yaml';
import type { FlowDocument } from '../../src/core/flow/types';
import { closeAll, flowUri, openDesigner, testApi, VIEW_TYPE } from './helpers';

const ROOT = join(__dirname, '../../..');

async function until(check: () => boolean, what: string, ms = 15_000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error(`timed out: ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

const activeTab = () => vscode.window.tabGroups.activeTabGroup.activeTab;

describe('AFD-22 acceptance: user help', () => {
  afterEach(closeAll);

  it('Open Sample Flow copies the sample into flows/<key>/ and opens the designer; a second run keeps changes', async () => {
    await testApi();
    const uri = flowUri('firewall-upgrade');
    await vscode.commands.executeCommand('afd.openSample', 'firewall-upgrade');
    await until(() => activeTab()?.input instanceof vscode.TabInputCustom, 'designer tab');
    const input = activeTab()?.input as vscode.TabInputCustom;
    assert.equal(input.viewType, VIEW_TYPE);
    assert.equal(input.uri.toString(), uri.toString());
    const copied = readFileSync(uri.fsPath, 'utf8');
    assert.equal(copied, readFileSync(join(ROOT, 'samples/firewall-upgrade.flow.yaml'), 'utf8'));
    await closeAll();
    // Changed while following a tutorial: opened as it is.
    const changed = `${copied}# my notes\n`;
    await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(changed));
    await vscode.commands.executeCommand('afd.openSample', 'firewall-upgrade');
    await until(() => activeTab()?.input instanceof vscode.TabInputCustom, 'designer tab again');
    assert.equal(readFileSync(uri.fsPath, 'utf8'), changed);
    await closeAll();
    // Other suites list the workspace's flows.
    await vscode.workspace.fs.delete(vscode.Uri.joinPath(uri, '..'), { recursive: true });
  });

  it('Open User Guide shows a guide page in the Markdown preview, never a file outside it', async () => {
    await vscode.commands.executeCommand('afd.openGuide', 'how-to/subflows.md');
    await until(() => /Subflows/i.test(activeTab()?.label ?? ''), 'subflows preview');
    assert.ok(activeTab()?.input instanceof vscode.TabInputWebview, String(activeTab()?.label));
    await closeAll();
    await vscode.commands.executeCommand('afd.openGuide', '../../package.json');
    await until(() => /README/i.test(activeTab()?.label ?? ''), 'index preview');
  });

  it('Get Started opens the walkthrough', async () => {
    await vscode.commands.executeCommand('afd.openWalkthrough');
    await until(() => /Walkthrough|Welcome|Get Started/i.test(activeTab()?.label ?? ''), 'welcome');
  });

  it('designer edits set the tour keys that check off walkthrough steps', async () => {
    const api = await testApi();
    const uri = flowUri('edge-baseline');
    await openDesigner(uri);
    const doc = parse(readFileSync(uri.fsPath, 'utf8')) as FlowDocument;
    const precheck = doc.nodes.find((n) => n.key === 'precheck');
    assert.ok(precheck);
    assert.ok((await api.run(uri, { kind: 'addNode', type: 'subflow', title: 'Tour subflow' })).ok);
    const pattern = await api.run(uri, {
      kind: 'applyPattern',
      pattern: 'exclude',
      from: { node: precheck.id, port: 'failed_hosts' },
    });
    assert.ok(pattern.ok, pattern.error);
    assert.deepEqual(api.tour().sort(), ['failureHandled', 'nodeAdded', 'subflow']);
  });
});

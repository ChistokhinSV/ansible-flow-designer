// AFD-258 inside VS Code: the Inventory view's Open in Editor goes to the line a host or a group
// is written on (a host of a range to the range), and New Inventory… creates a YAML inventory, makes
// it the workspace's and opens it. Files only: no Ansible environment is needed.
import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
import { parse } from 'yaml';
import { closeAll, testApi } from './helpers';

const root = () => vscode.workspace.workspaceFolders?.[0]?.uri as vscode.Uri;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until(check: () => boolean, what: string, ms = 15_000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error(`timed out: ${what}`);
    await sleep(100);
  }
}

/** The file and the text of the line the cursor is on. */
function cursor(): { file: string; text: string } {
  const editor = vscode.window.activeTextEditor;
  if (!editor) return { file: '', text: '' };
  return {
    file: vscode.workspace.asRelativePath(editor.document.uri),
    text: editor.document.lineAt(editor.selection.active.line).text,
  };
}

describe('AFD-258: the Inventory view and the inventory files', () => {
  before(async () => {
    await testApi();
  });
  afterEach(closeAll);

  it('a host opens at its line under the group it is listed in', async () => {
    await vscode.commands.executeCommand('afd.inventory.open', {
      kind: 'host',
      host: 'h07',
      group: 'lab',
    });
    await until(() => cursor().text.startsWith('h07 '), 'the line of h07');
    assert.equal(cursor().file, 'inventory.ini');
  });

  it('a host of a range opens at the range', async () => {
    await vscode.commands.executeCommand('afd.inventory.open', {
      kind: 'host',
      host: 'sw-edge-02',
      group: 'edge',
    });
    await until(() => cursor().text === 'sw-edge-0[1:4]', 'the line of the range');
  });

  it('a group opens at its section', async () => {
    await vscode.commands.executeCommand('afd.inventory.open', {
      kind: 'group',
      group: { name: 'edge_switches', hosts: [], children: ['edge'], count: 4 },
    });
    await until(() => cursor().text === '[edge_switches:children]', 'the section');
  });

  it('a group Ansible adds itself opens nothing', async () => {
    await vscode.commands.executeCommand('afd.inventory.open', {
      kind: 'group',
      group: { name: 'ungrouped', hosts: [], children: [], count: 0 },
    });
    await sleep(300);
    assert.equal(vscode.window.activeTextEditor, undefined);
    await vscode.commands.executeCommand('notifications.clearAll');
  });

  it('New Inventory… creates a YAML inventory, sets it for the workspace and opens it', async () => {
    const afd = () => vscode.workspace.getConfiguration('afd');
    const file = vscode.Uri.joinPath(root(), 'inventory', 'hosts.yml');
    const command = vscode.commands.executeCommand('afd.inventory.new');
    try {
      // The box proposes inventory/hosts.yml: accepted as it is.
      await sleep(1500);
      await vscode.commands.executeCommand('workbench.action.acceptSelectedQuickOpenItem');
      assert.equal(await command, true);
      assert.equal(cursor().file, 'inventory/hosts.yml');
      const text = new TextDecoder().decode(await vscode.workspace.fs.readFile(file));
      assert.deepEqual(parse(text), { all: { children: {} } });
      assert.equal(afd().inspect('run.inventory')?.workspaceValue, 'inventory/hosts.yml');
      // The view's files are these now: a group written there opens there.
      await vscode.commands.executeCommand('afd.inventory.refresh');
      await vscode.commands.executeCommand('afd.inventory.open', {
        kind: 'group',
        group: { name: 'all', hosts: [], children: [], count: 0 },
      });
      await until(() => cursor().text === 'all:', 'all: in the new inventory');
    } finally {
      await afd().update('run.inventory', undefined, vscode.ConfigurationTarget.Workspace);
      await closeAll();
      await vscode.workspace.fs.delete(vscode.Uri.joinPath(root(), 'inventory'), {
        recursive: true,
      });
    }
  }).timeout(30_000);
});

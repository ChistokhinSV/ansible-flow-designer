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

const win = vscode.window as unknown as Record<string, (...args: never[]) => unknown>;

/**
 * Answers the boxes, lists and confirmations an edit opens, in order; an answer its box refuses
 * fails the test. Returns the error messages shown, and puts the window back.
 */
async function answering<T>(
  answers: { input?: string[]; pick?: string[]; confirm?: string },
  run: () => Thenable<T>,
): Promise<{ result: T; errors: string[] }> {
  // Only these four: reading every member of vscode.window touches proposed API, which throws.
  const real = {
    showInputBox: win.showInputBox,
    showQuickPick: win.showQuickPick,
    showWarningMessage: win.showWarningMessage,
    showErrorMessage: win.showErrorMessage,
  } as Record<string, unknown>;
  const errors: string[] = [];
  const inputs = [...(answers.input ?? [])];
  const picks = [...(answers.pick ?? [])];
  win.showInputBox = (async (options: vscode.InputBoxOptions) => {
    const value = inputs.shift();
    if (value === undefined) throw new Error(`an unexpected box: ${options.title}`);
    const refused = await options.validateInput?.(value);
    if (refused) throw new Error(`"${value}" was refused: ${JSON.stringify(refused)}`);
    return value;
  }) as never;
  win.showQuickPick = (async (items: (string | vscode.QuickPickItem)[]) => {
    const label = picks.shift();
    const found = items.find((i) => (typeof i === 'string' ? i : i.label) === label);
    if (!found) throw new Error(`"${label}" is not offered`);
    return found;
  }) as never;
  win.showWarningMessage = (async () => answers.confirm) as never;
  win.showErrorMessage = (async (message: string) => {
    errors.push(message);
  }) as never;
  try {
    return { result: await run(), errors };
  } finally {
    for (const name of ['showInputBox', 'showQuickPick', 'showWarningMessage', 'showErrorMessage'])
      win[name] = real[name] as never;
  }
}

const cmd = (id: string, item?: unknown) => () => vscode.commands.executeCommand<boolean>(id, item);
const read = async (path: string) =>
  new TextDecoder().decode(await vscode.workspace.fs.readFile(vscode.Uri.joinPath(root(), path)));
const lines = async (path: string) => (await read(path)).split('\n');

describe('AFD-259, AFD-260: editing the inventory from the view', () => {
  let original: string;
  before(async () => {
    await testApi();
    original = await read('inventory.ini');
  });
  afterEach(async () => {
    await closeAll();
    await vscode.workspace.fs.writeFile(
      vscode.Uri.joinPath(root(), 'inventory.ini'),
      new TextEncoder().encode(original),
    );
    await vscode.workspace.fs
      .delete(vscode.Uri.joinPath(root(), 'host_vars'), { recursive: true })
      .then(undefined, () => undefined);
    await vscode.commands.executeCommand('afd.inventory.refresh');
  });
  const lab = { kind: 'group', group: { name: 'lab' } };

  it('adds a host to a group, renames it, moves it and removes it; the file is saved each time', async () => {
    let r = await answering({ input: ['h99'] }, cmd('afd.inventory.addHost', lab));
    assert.deepEqual(r, { result: true, errors: [] });
    let text = await lines('inventory.ini');
    assert.equal(text[text.findIndex((l) => l.startsWith('h07 ')) + 1], 'h99');
    assert.ok(!vscode.workspace.textDocuments.some((d) => d.isDirty), 'saved');

    r = await answering(
      { input: ['h98'] },
      cmd('afd.inventory.rename', { kind: 'host', host: 'h99', group: 'lab' }),
    );
    assert.equal(r.result, true);
    r = await answering(
      { pick: ['lb'] },
      cmd('afd.inventory.moveHost', { kind: 'host', host: 'h98', group: 'lab' }),
    );
    assert.equal(r.result, true);
    text = await lines('inventory.ini');
    assert.equal(text[text.indexOf('lb-0[1:2]') + 1], 'h98');
    assert.equal(text.filter((l) => l === 'h98').length, 1);

    r = await answering(
      { confirm: 'Remove from lb' },
      cmd('afd.inventory.remove', { kind: 'host', host: 'h98', group: 'lb' }),
    );
    assert.equal(r.result, true);
    assert.equal(await read('inventory.ini'), original);
  }).timeout(30_000);

  it('a host that is one of a range is refused, with the reason, and nothing is written', async () => {
    const r = await answering(
      { confirm: 'Remove from lab' },
      cmd('afd.inventory.remove', { kind: 'host', host: 'h03', group: 'lab' }),
    );
    assert.equal(r.result, false);
    assert.match(r.errors[0] ?? '', /one of the range h0\[1:6\]/);
    assert.equal(await read('inventory.ini'), original);
  });

  it('adds a group, a child group, renames it and deletes it', async () => {
    let r = await answering({ input: ['dmz'] }, cmd('afd.inventory.addGroup'));
    assert.deepEqual(r, { result: true, errors: [] });
    r = await answering(
      { input: ['dmz_fw'] },
      cmd('afd.inventory.addGroup', { kind: 'group', group: { name: 'dmz' } }),
    );
    assert.deepEqual(r, { result: true, errors: [] });
    let text = await read('inventory.ini');
    assert.match(text, /\n\[dmz\]\n/);
    assert.match(text, /\n\[dmz_fw\]\n/);
    assert.match(text, /\n\[dmz:children\]\ndmz_fw\n/);
    r = await answering(
      { input: ['perimeter'] },
      cmd('afd.inventory.rename', { kind: 'group', group: { name: 'dmz' } }),
    );
    assert.equal(r.result, true);
    text = await read('inventory.ini');
    assert.match(text, /\n\[perimeter:children\]\ndmz_fw\n/);
    assert.doesNotMatch(text, /\[dmz[\]:]/);
    r = await answering(
      { confirm: 'Delete Group' },
      cmd('afd.inventory.remove', { kind: 'group', group: { name: 'perimeter' } }),
    );
    assert.equal(r.result, true);
    assert.doesNotMatch(await read('inventory.ini'), /perimeter/);
    // Ansible's own groups stay as they are.
    r = await answering({}, cmd('afd.inventory.remove', { kind: 'group', group: { name: 'all' } }));
    assert.equal(r.result, false);
    await vscode.commands.executeCommand('notifications.clearAll');
  }).timeout(30_000);

  it('a variable of a host written in the file goes on its line; of a group, into its :vars', async () => {
    const h07 = { kind: 'host', host: 'h07', group: 'lab' };
    let r = await answering({ input: ['site', 'Lab A'] }, cmd('afd.inventory.addVar', h07));
    assert.deepEqual(r, { result: true, errors: [] });
    assert.match(await read('inventory.ini'), /\nh07 .* site="Lab A"\n/);
    r = await answering({ input: ['snmp_location', 'rack 4'] }, cmd('afd.inventory.addVar', lab));
    assert.equal(r.result, true);
    assert.match(await read('inventory.ini'), /\n\[lab:vars\]\nsnmp_location="rack 4"\n/);
    // A name that is set already is refused in the box.
    await assert.rejects(
      answering({ input: ['site', 'x'] }, cmd('afd.inventory.addVar', h07)),
      /refused/,
    );
  }).timeout(30_000);

  it('a host of a range gets a variables file; its value is edited and removed there', async () => {
    const h03 = { kind: 'host', host: 'h03', group: 'lab' };
    let r = await answering({ input: ['vlans', '[10, 20]'] }, cmd('afd.inventory.addVar', h03));
    assert.deepEqual(r, { result: true, errors: [] });
    assert.equal(await read('host_vars/h03.yml'), '---\nvlans:\n  - 10\n  - 20\n');
    r = await answering({ input: ['ansible_port', '2222'] }, cmd('afd.inventory.addVar', h03));
    assert.equal(r.result, true);
    assert.deepEqual(parse(await read('host_vars/h03.yml')), {
      vlans: [10, 20],
      ansible_port: 2222,
    });

    const variable = {
      key: 'ansible_port',
      value: 2222,
      file: 'host_vars/h03.yml',
      line: 4,
      inline: false,
    };
    r = await answering(
      { input: ['22'] },
      cmd('afd.inventory.editVar', { kind: 'var', variable, host: 'h03' }),
    );
    assert.equal(r.result, true);
    assert.equal(parse(await read('host_vars/h03.yml')).ansible_port, 22);
    r = await answering({}, cmd('afd.inventory.remove', { kind: 'var', variable, host: 'h03' }));
    assert.equal(r.result, true);
    assert.deepEqual(parse(await read('host_vars/h03.yml')), { vlans: [10, 20] });
    assert.equal(await read('inventory.ini'), original);
  }).timeout(30_000);
});

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

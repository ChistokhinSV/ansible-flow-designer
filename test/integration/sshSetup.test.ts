// AFD-250, AFD-247 inside VS Code: Set Up Ansible Environment… for an SSH host, through its real
// quick picks and input boxes, and Copy a File to the SSH Host…. Needs AFD_TEST_SSH_SETUP, a Host
// of this machine's SSH config that connects without a password (`just test-ssh-setup <host>`);
// skipped without it. The workspace starts with no environment set: the setup writes it.
//
// The lists and boxes are VS Code's own: the test watches the calls the extension makes to open
// them, then moves and accepts with the commands the keys are bound to. Only the file dialog,
// which is the operating system's, is answered by the test.
import * as assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as vscode from 'vscode';
import { closeAll, flowUri, openDesigner, testApi, withTimeout } from './helpers';

const host = process.env.AFD_TEST_SSH_SETUP;
/** An image the user settings name (as the Docker setup leaves one): AFD_TEST_IMAGE, on the host too. */
const userImage = process.env.AFD_TEST_IMAGE;
const HELLO = flowUri('hello');

interface Shown {
  kind: 'pick' | 'input' | 'info' | 'error' | 'open';
  labels?: string[];
  /** The label of the item marked as the one in use. */
  inUse?: string;
  title?: string;
  value?: string;
  message?: string;
}

const shown: Shown[] = [];
const win = vscode.window as unknown as Record<string, (...args: unknown[]) => unknown>;
const originals: Record<string, (...args: unknown[]) => unknown> = {};
let openAnswer: vscode.Uri[] | undefined;

/** Records each list, box and message the extension opens; they open as they always do. */
function watch(): void {
  const wrap = (name: string, note: (args: unknown[]) => Shown, answer?: () => unknown) => {
    const real = win[name] as (...args: unknown[]) => unknown;
    originals[name] = real;
    win[name] = (...args: unknown[]) => {
      shown.push(note(args));
      return answer ? answer() : real.apply(vscode.window, args);
    };
  };
  wrap('showQuickPick', ([items, options]) => ({
    kind: 'pick',
    title: (options as vscode.QuickPickOptions | undefined)?.title,
    labels: (items as (string | vscode.QuickPickItem)[]).map((i) =>
      typeof i === 'string' ? i : i.label,
    ),
    inUse: (items as (string | vscode.QuickPickItem)[])
      .map((i) => (typeof i === 'string' ? undefined : i.description === 'in use' && i.label))
      .find((l): l is string => !!l),
  }));
  wrap('showInputBox', ([options]) => ({
    kind: 'input',
    title: (options as vscode.InputBoxOptions | undefined)?.title,
    value: (options as vscode.InputBoxOptions | undefined)?.value,
  }));
  wrap('showInformationMessage', ([message]) => ({ kind: 'info', message: String(message) }));
  wrap('showErrorMessage', ([message]) => ({ kind: 'error', message: String(message) }));
  wrap(
    'showOpenDialog',
    () => ({ kind: 'open' }),
    () => Promise.resolve(openAnswer),
  );
}

function unwatch(): void {
  for (const [name, real] of Object.entries(originals)) win[name] = real;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The next thing shown from `from` on that is one of `kinds`; an error message fails at once. */
async function next(from: number, kinds: Shown['kind'][], what: string, ms = 60_000) {
  const end = Date.now() + ms;
  for (;;) {
    const rest = shown.slice(from);
    const error = kinds.includes('error') ? undefined : rest.find((s) => s.kind === 'error');
    if (error) throw new Error(`${what}: ${error.message}`);
    const at = rest.findIndex((s) => kinds.includes(s.kind));
    if (at >= 0) return { item: rest[at] as Shown, after: from + at + 1 };
    if (Date.now() > end) throw new Error(`timed out: ${what}; shown: ${JSON.stringify(rest)}`);
    await sleep(100);
  }
}

/** Moves down to the item of this label in the open list and accepts it, as the keys do. */
async function choose(pick: Shown, label: string): Promise<void> {
  const at = pick.labels?.indexOf(label) ?? -1;
  assert.ok(at >= 0, `"${label}" is offered in: ${pick.labels?.join(' | ')}`);
  await sleep(500);
  // A separator (an empty label) is no stop of the list.
  const steps = (pick.labels ?? []).slice(0, at).filter((l) => l !== '').length;
  for (let i = 0; i < steps; i++)
    await vscode.commands.executeCommand('workbench.action.quickOpenSelectNext');
  await sleep(200);
  await vscode.commands.executeCommand('workbench.action.acceptSelectedQuickOpenItem');
}

const onHost = (script: string) =>
  execFileSync('ssh', ['-T', '-o', 'BatchMode=yes', host as string, script], {
    encoding: 'utf8',
    timeout: 30_000,
  }).trim();

const setting = (key: string) =>
  vscode.workspace.getConfiguration('afd').inspect(`environment.${key}`)?.workspaceValue;

describe('AFD-247: Set Up Ansible Environment… for an SSH host', () => {
  before(async function () {
    if (!host) this.skip();
    const afd = vscode.workspace.getConfiguration('afd');
    // The test configuration puts AFD_TEST_IMAGE in the workspace settings for the run suites:
    // here it is the user's (as the Docker setup leaves it), and the workspace starts with none.
    await afd.update('environment.image', undefined, vscode.ConfigurationTarget.Workspace);
    await afd.update('environment.image', userImage, vscode.ConfigurationTarget.Global);
    watch();
  });
  after(async () => {
    unwatch();
    await vscode.workspace
      .getConfiguration('afd')
      .update('environment.image', undefined, vscode.ConfigurationTarget.Global);
    await closeAll();
  });

  it('the setup lists the SSH config hosts, checks the host and writes the workspace settings', async () => {
    await testApi();
    assert.equal(setting('kind'), undefined, 'no environment is set at the start');
    let at = shown.length;
    const command = Promise.resolve(vscode.commands.executeCommand('afd.environment.setup'));

    const first = await next(at, ['pick'], 'the list of environments');
    assert.equal(first.item.title, 'Set Up Ansible Environment');
    assert.equal(first.item.labels?.at(-1), 'Read About Ansible Environments');
    await choose(first.item, 'A Remote Linux Host over SSH');
    at = first.after;

    const hosts = await next(at, ['pick'], 'the list of hosts');
    assert.equal(hosts.item.title, 'Set Up Ansible Environment: SSH Host');
    assert.equal(hosts.item.labels?.at(-1), 'Another Host…');
    assert.ok(
      !hosts.item.labels?.some((l) => /[*?!]/.test(l)),
      'no pattern of the SSH config is offered as a host',
    );
    await choose(hosts.item, host as string);
    at = hosts.after;

    // A host without Ansible on its PATH but with a container engine is asked for an image.
    let step = await next(at, ['input', 'info'], 'the image box or the result');
    let image: string | undefined;
    if (step.item.kind === 'input') {
      image = step.item.value;
      // The user's own image when they have one, the public one otherwise.
      if (userImage) assert.equal(image, userImage);
      else assert.match(image ?? '', /ansible-dev-tools/);
      await sleep(500);
      await vscode.commands.executeCommand('workbench.action.acceptSelectedQuickOpenItem');
      step = await next(step.after, ['info'], 'the result');
    }
    assert.match(step.item.message ?? '', /^The Ansible environment is set: /);
    assert.match(step.item.message ?? '', new RegExp(` on ${host}\\. `));
    const folder = vscode.workspace.workspaceFolders?.[0]?.name as string;
    assert.ok(step.item.message?.includes(`copies the repository to ~/.afd/${folder} there`));
    // What it says is what runs: the host's own Ansible is not replaced by the user's image.
    assert.match(
      step.item.message ?? '',
      image ? new RegExp(`docker: ${image} on ${host}`) : /the ansible-playbook of \S+ on /,
    );
    await vscode.commands.executeCommand('notifications.clearAll');
    assert.equal(await withTimeout(command, 10_000, 'the setup command ends'), true);

    assert.equal(setting('kind'), 'ssh');
    assert.equal(setting('sshHost'), host);
    // AFD-255: the host's image is its own setting, empty for the host's own Ansible; the image of
    // this machine is neither used there nor touched.
    assert.equal(setting('sshImage'), image ?? '');
    assert.equal(setting('image'), undefined);
    assert.equal(setting('containerEngine'), image ? 'docker' : undefined);
    const afd = vscode.workspace.getConfiguration('afd');
    assert.equal(afd.inspect('environment.kind')?.globalValue, undefined, 'user settings: kind');
    assert.equal(afd.inspect('environment.image')?.globalValue, userImage, 'user settings: image');
  }).timeout(120_000);

  it('the environment the setup wrote runs the Hello sample as a skeleton on the host', async function () {
    // The public image the setup proposes is pulled by the first run: not here, the lab link is
    // slow. The user's own image (AFD_TEST_IMAGE) is on the host already.
    if (setting('sshImage') && setting('sshImage') !== userImage) this.skip();
    await openDesigner(HELLO);
    const api = await testApi();
    const run = await withTimeout(
      api.runFlow(HELLO, { mode: 'check', inputs: { devices: ['localhost'] } }),
      240_000,
      'Hello skeleton run over SSH',
    );
    if (run.state !== 'done') throw new Error(JSON.stringify(run));
    assert.equal(run.rc, 0);
    const folder = vscode.workspace.workspaceFolders?.[0]?.name as string;
    assert.match(onHost(`ls "$HOME/.afd/${folder}"`), /repo/);
  }).timeout(300_000);

  it('AFD-255: Switch Ansible Environment… lists what is configured, and a switch rewrites the kind only', async function () {
    const before = { sshHost: setting('sshHost'), sshImage: setting('sshImage') };
    let at = shown.length;
    let command = vscode.commands.executeCommand('afd.environment.switch');
    const list = await next(at, ['pick'], 'the list of environments');
    assert.equal(list.item.title, 'Switch Ansible Environment');
    assert.equal(list.item.labels?.at(-1), 'Set Up Another…');
    const ssh = `SSH: ${host}`;
    assert.equal(list.item.inUse, ssh);
    const other = list.item.labels?.find((l) => l && l !== ssh && l !== 'Set Up Another…');
    if (!other) {
      // No image in the user settings and no WSL here: nothing else is one click away.
      await vscode.commands.executeCommand('workbench.action.closeQuickOpen');
      await command;
      this.skip();
    }
    await choose(list.item, other as string);
    assert.equal(await withTimeout(Promise.resolve(command), 10_000, 'the switch ends'), true);
    const kind = (other as string).startsWith('WSL: ') ? 'wsl' : 'container';
    assert.equal(setting('kind'), kind);
    assert.deepEqual({ sshHost: setting('sshHost'), sshImage: setting('sshImage') }, before);
    if (kind === 'container') assert.equal(setting('image'), undefined);

    // And back: the host and its image were kept, so nothing is asked.
    at = shown.length;
    command = vscode.commands.executeCommand('afd.environment.switch');
    const again = await next(at, ['pick'], 'the list of environments');
    assert.equal(again.item.inUse, other);
    await choose(again.item, ssh);
    assert.equal(await withTimeout(Promise.resolve(command), 10_000, 'the switch ends'), true);
    assert.equal(setting('kind'), 'ssh');
    assert.deepEqual({ sshHost: setting('sshHost'), sshImage: setting('sshImage') }, before);
    assert.ok(!shown.slice(at).some((x) => x.kind === 'input'), 'nothing was asked');
  }).timeout(60_000);

  it('AFD-256: Switch Inventory… lists the inventories of the repository and writes the workspace setting', async () => {
    const inventory = () =>
      vscode.workspace.getConfiguration('afd').inspect('run.inventory')?.workspaceValue;
    assert.equal(inventory(), undefined);
    let at = shown.length;
    let command = vscode.commands.executeCommand('afd.inventory.switch');
    const list = await next(at, ['pick'], 'the list of inventories');
    assert.equal(list.item.title, 'Switch Inventory');
    assert.equal(list.item.labels?.[0], 'The Default of ansible.cfg');
    assert.equal(list.item.inUse, 'The Default of ansible.cfg');
    assert.equal(list.item.labels?.at(-1), 'Browse…');
    await choose(list.item, 'inventory.ini');
    assert.equal(await withTimeout(Promise.resolve(command), 10_000, 'the switch ends'), true);
    assert.equal(inventory(), 'inventory.ini');

    at = shown.length;
    command = vscode.commands.executeCommand('afd.inventory.switch');
    const again = await next(at, ['pick'], 'the list of inventories');
    assert.equal(again.item.inUse, 'inventory.ini');
    await choose(again.item, 'The Default of ansible.cfg');
    assert.equal(await withTimeout(Promise.resolve(command), 10_000, 'the switch ends'), true);
    assert.equal(inventory(), undefined);
  }).timeout(60_000);

  it('Copy a File to the SSH Host… proposes a path beside the copy and writes it for the account alone', async () => {
    const folder = vscode.workspace.workspaceFolders?.[0]?.name as string;
    const name = `afd-test-${process.pid}.txt`;
    const local = join(mkdtempSync(join(tmpdir(), 'afd-copy-')), name);
    writeFileSync(local, 'not a secret: a test file\n');
    openAnswer = [vscode.Uri.file(local)];
    const at = shown.length;
    const command = vscode.commands.executeCommand('afd.environment.copyFile');

    const box = await next(at, ['input'], 'the path box');
    assert.equal(box.item.title, `Copy ${name} to ${host}`);
    assert.equal(box.item.value, `~/.afd/${folder}/files/${name}`);
    await sleep(500);
    await vscode.commands.executeCommand('workbench.action.acceptSelectedQuickOpenItem');
    const told = await next(box.after, ['info'], 'the result');
    assert.equal(
      told.item.message,
      `Copied ${name} to ${host}:~/.afd/${folder}/files/${name} (readable by the account alone).`,
    );
    await command;
    await vscode.commands.executeCommand('notifications.clearAll');

    const remote = `"$HOME/.afd/${folder}/files/${name}"`;
    try {
      assert.equal(onHost(`stat -c '%a' ${remote}`), '600');
      assert.equal(onHost(`cat ${remote}`), 'not a secret: a test file');
      assert.equal(onHost(`stat -c '%a' "$HOME/.afd/${folder}"`), '700');
    } finally {
      onHost(`rm -f ${remote}`);
    }
  }).timeout(120_000);

  it('AFD-250: a container setup in a workspace with an SSH environment writes there, so it is what runs', async function () {
    const afd = () => vscode.workspace.getConfiguration('afd');
    const before = Object.fromEntries(
      ['kind', 'image', 'containerEngine'].map((key) => [key, setting(key)]),
    );
    let at = shown.length;
    const command = Promise.resolve(vscode.commands.executeCommand('afd.environment.setup'));
    const first = await next(at, ['pick'], 'the list of environments');
    const engine = first.item.labels?.find((l) => l === 'Docker' || l === 'Podman');
    if (!engine) {
      // Neither is on this machine: nothing to choose.
      await vscode.commands.executeCommand('workbench.action.closeQuickOpen');
      await command;
      this.skip();
    }
    try {
      await choose(first.item, engine as string);
      at = first.after;
      const box = await next(at, ['input'], 'the image box');
      await sleep(500);
      await vscode.commands.executeCommand('workbench.action.acceptSelectedQuickOpenItem');
      const told = await next(box.after, ['info'], 'the result');
      assert.match(told.item.message ?? '', /^The Ansible environment is set: (docker|podman): /);
      await vscode.commands.executeCommand('notifications.clearAll');
      await withTimeout(command, 10_000, 'the setup command ends');
      assert.equal(setting('kind'), 'container');
      assert.equal(setting('image'), box.item.value);
      assert.equal(afd().get('environment.kind'), 'container');
      assert.equal(afd().inspect('environment.kind')?.globalValue, undefined);
      assert.equal(afd().inspect('environment.image')?.globalValue, userImage);
    } finally {
      for (const [key, value] of Object.entries(before))
        await afd().update(`environment.${key}`, value, vscode.ConfigurationTarget.Workspace);
    }
  }).timeout(60_000);

  it('without an SSH environment the copy says so and opens nothing', async () => {
    const afd = vscode.workspace.getConfiguration('afd');
    const kind = setting('kind');
    await afd.update('environment.kind', undefined, vscode.ConfigurationTarget.Workspace);
    try {
      const at = shown.length;
      await vscode.commands.executeCommand('afd.environment.copyFile');
      const told = await next(at, ['error'], 'the message');
      assert.match(told.item.message ?? '', /is for an SSH environment/);
      assert.ok(!shown.slice(at).some((s) => s.kind === 'open'));
      await vscode.commands.executeCommand('notifications.clearAll');
    } finally {
      await afd.update('environment.kind', kind, vscode.ConfigurationTarget.Workspace);
    }
  });
});

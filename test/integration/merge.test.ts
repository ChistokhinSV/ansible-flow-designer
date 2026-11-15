// AFD-283 inside VS Code: git merges a flow through the merge driver and leaves a conflict; the
// designer shows the Merge note, a choice rewrites the file (and can be taken back), and Finish
// merge saves it and marks it merged in git. Set Up Flow Merging writes what it says it writes.
import * as assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import * as vscode from 'vscode';
import { closeAll, openDesigner, testApi } from './helpers';

/** The repository (the bundle runs from out/test/integration). */
const REPO = resolve(__dirname, '../../..');
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
const root = () => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath as string;

describe('AFD-283: flows merge in git by their steps', () => {
  let dir: string;
  let flow: vscode.Uri;
  const git = (...args: string[]) =>
    spawnSync('git', args, { cwd: dir, encoding: 'utf8', windowsHide: true });

  before(() => {
    dir = join(root(), 'merge-e2e');
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(join(dir, 'flows'), { recursive: true });
    const run = (...args: string[]) => {
      const r = git(...args);
      assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
    };
    run('init', '-q', '-b', 'main');
    run('config', 'user.name', 'Dana Whitfield');
    run('config', 'user.email', 'dana@example.net');
    run('config', 'core.autocrlf', 'false');
    run(
      'config',
      'merge.ansible-flow.driver',
      `node "${join(REPO, 'dist', 'afd-merge.js')}" %O %A %B %P`,
    );
    writeFileSync(join(dir, '.gitattributes'), '*.flow.yaml merge=ansible-flow\n');
    const file = join(dir, 'flows', 'edge-baseline.flow.yaml');
    const base = readFileSync(join(REPO, 'examples', 'edge-baseline.flow.yaml'), 'utf8');
    writeFileSync(file, base);
    run('add', '-A');
    run('commit', '-q', '-m', 'base');
    run('checkout', '-q', '-b', 'mia');
    writeFileSync(
      file,
      base
        .replace('  title: Validate\n', '  title: Check it\n')
        .replace('  title: Backup config\n', '  title: Back up the config\n'),
    );
    run('commit', '-q', '-am', 'mia');
    run('checkout', '-q', 'main');
    writeFileSync(
      file,
      `# Owned by the edge team\n${base.replace('  title: Validate\n', '  title: Validate it\n')}`,
    );
    run('commit', '-q', '-am', 'ours');
    const merge = git('merge', '--no-edit', 'mia');
    assert.notEqual(merge.status, 0, 'the merge leaves the conflict to a person');
    flow = vscode.Uri.file(file);
  });
  after(async () => {
    await closeAll();
    // VS Code's git may still watch the folder on Windows: the test workspace goes away anyway.
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    } catch {
      // left in out/test-workspace, which the next run starts afresh
    }
  });

  it('the driver merged what it could and left a flow without markers', () => {
    const text = readFileSync(flow.fsPath, 'utf8');
    assert.ok(!text.includes('<<<<<<<'), text.slice(0, 400));
    assert.ok(text.startsWith('# Owned by the edge team\n'));
    assert.ok(text.includes('  title: Validate it\n'));
    assert.ok(text.includes('  title: Back up the config\n'));
    assert.ok(existsSync(join(dir, '.git', 'afd-merge', 'flows%2Fedge-baseline.flow.yaml.json')));
  });

  it('the Merge note offers Mine and Theirs; a choice changes the file and can be taken back', async () => {
    const doc = await openDesigner(flow);
    const api = await testApi();
    const until = Date.now() + 20_000;
    while ((await api.inspect(flow)).merge !== 1) {
      assert.ok(Date.now() < until, 'the Merge note shows one conflict');
      await pause(200);
    }
    const view = await api.merge(flow);
    assert.equal(view?.conflicts.length, 1);
    const [c] = view?.conflicts ?? [];
    assert.equal(c?.label, 'Validate it: title');
    assert.equal(c?.chosen, 'ours');

    await api.mergeChoose(flow, c?.id as string, 'theirs');
    assert.ok(doc.getText().includes('  title: Check it\n'), 'theirs is in the file');
    assert.ok(doc.getText().startsWith('# Owned by the edge team\n'), 'comments stay');
    assert.equal((await api.merge(flow))?.conflicts[0]?.chosen, 'theirs');
    await api.mergeChoose(flow, c?.id as string, 'ours');
    assert.ok(doc.getText().includes('  title: Validate it\n'), 'a choice can be taken back');
    await api.mergeChoose(flow, c?.id as string, 'theirs');

    assert.equal(await api.mergeFinish(flow), true);
    assert.equal(doc.isDirty, false, 'Finish saves');
    assert.ok(readFileSync(flow.fsPath, 'utf8').includes('  title: Check it\n'));
    assert.equal(
      git('diff', '--name-only', '--diff-filter=U').stdout.trim(),
      '',
      'git takes it as merged',
    );
    assert.ok(!existsSync(join(dir, '.git', 'afd-merge', 'flows%2Fedge-baseline.flow.yaml.json')));
    const after = Date.now() + 10_000;
    while ((await api.inspect(flow)).merge !== null) {
      assert.ok(Date.now() < after, 'the note goes');
      await pause(200);
    }
    assert.equal(git('commit', '-q', '--no-edit').status, 0);
  });

  it('Set Up Flow Merging copies the driver, adds the attributes and sets git', async () => {
    const top = root();
    const attributes = join(top, '.gitattributes');
    const had = existsSync(attributes) ? readFileSync(attributes, 'utf8') : undefined;
    try {
      await vscode.commands.executeCommand('afd.flow.setupMerging');
      assert.ok(existsSync(join(top, '.afd', 'afd-merge.js')));
      assert.match(readFileSync(attributes, 'utf8'), /\*\.flow\.yaml merge=ansible-flow/);
      const driver = execFileSync('git', ['config', 'merge.ansible-flow.driver'], {
        cwd: top,
        encoding: 'utf8',
      }).trim();
      assert.equal(driver, 'node .afd/afd-merge.js %O %A %B %P');
    } finally {
      if (had === undefined) rmSync(attributes, { force: true });
      else writeFileSync(attributes, had);
      rmSync(join(top, '.afd', 'afd-merge.js'), { force: true });
      spawnSync('git', ['config', '--unset', 'merge.ansible-flow.driver'], { cwd: top });
      spawnSync('git', ['config', '--unset', 'merge.ansible-flow.name'], { cwd: top });
    }
  });
});

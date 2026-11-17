// AFD-320: History inside VS Code. A repository made for the test has two commits of a flow; the
// second commit's flow opens as a past version: read-only, its commit in the banner, and the
// Changes lens compares it with the version before (the step the commit added is chipped). An
// edit asked of it is refused, and the file at the commit is left as it was.
import * as assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as vscode from 'vscode';
import { readLog } from '../../src/node/history/gitLog';
import { closeAll, testApi, withTimeout } from './helpers';

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

const START = '01J00000000000000000000001';
const END = '01J00000000000000000000002';
const CHECK = '01J00000000000000000000003';

const flow = (withCheck: boolean) => `schema_version: 2
flow:
  key: hist
  title: History sample
  version: 1
nodes:
  - id: ${START}
    key: start
    type: start
    title: Start
  - id: ${END}
    key: done
    type: end
    title: Done
${
  withCheck
    ? `  - id: ${CHECK}
    key: check
    type: task
    title: Check
`
    : ''
}edges:
${
  withCheck
    ? `  - from: { node: ${START}, port: ok_hosts }
    to: { node: ${CHECK} }
  - from: { node: ${CHECK}, port: ok_hosts }
    to: { node: ${END} }
`
    : `  - from: { node: ${START}, port: ok_hosts }
    to: { node: ${END} }
`
}`;

describe('AFD-320: History', () => {
  let root = '';
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true });

  before(() => {
    root = mkdtempSync(join(tmpdir(), 'afd-320-int-'));
    git('init', '-q', '-b', 'main');
    git('config', 'user.name', 'Dana Ops');
    git('config', 'user.email', 'dana@example.net');
    git('config', 'core.autocrlf', 'false');
    writeFileSync(join(root, 'hist.flow.yaml'), flow(false));
    git('add', '.');
    git('commit', '-q', '-m', 'First version');
    writeFileSync(join(root, 'hist.flow.yaml'), flow(true));
    git('commit', '-q', '-am', 'Add the check');
  });
  after(async () => {
    await closeAll();
    try {
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
    } catch {
      // Left in the temporary folder.
    }
  });

  it("opens a commit's flow read-only, in the Changes lens against the version before", async () => {
    const api = await testApi();
    const [second] = await readLog(root);
    assert.equal(second?.subject, 'Add the check');
    const uri = api.pastUri({
      root,
      hash: second?.hash as string,
      author: 'Dana Ops',
      date: second?.date as string,
      subject: 'Add the check',
      path: 'hist.flow.yaml',
      parent: true,
    });
    await vscode.commands.executeCommand('vscode.openWith', uri, 'afd.flowEditor');
    const doc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
    assert.ok(doc, 'the past document is open');
    await withTimeout(api.rendered(uri, doc.version), 30_000, 'first render');
    const until = Date.now() + 15_000;
    for (;;) {
      const dom = await api.inspect(uri);
      const chips = dom.lens?.chips[CHECK] ?? [];
      if (dom.lens?.lens === 'changes' && chips.length > 0) {
        assert.match(dom.past ?? '', /Dana Ops/);
        assert.match(dom.past ?? '', /Add the check/);
        assert.deepEqual(chips, ['added']);
        break;
      }
      assert.ok(Date.now() < until, `lens: ${JSON.stringify(dom.lens)} past: ${dom.past}`);
      await pause(200);
    }
    assert.equal(
      api.lensFacts(uri).compare?.label,
      `the version before ${second?.hash.slice(0, 7)}`,
    );
    // An edit asked of the past version is refused; the text stays the commit's.
    const outcome = await api.run(uri, {
      kind: 'updateNode',
      id: CHECK,
      patch: { title: 'Changed' },
    });
    assert.equal(outcome.ok, false);
    assert.equal(doc.getText(), flow(true));
  });

  it("the flow's history lists the commits that changed it", async () => {
    const api = await testApi();
    const picks = await api.flowHistory(vscode.Uri.file(join(root, 'hist.flow.yaml')));
    assert.deepEqual(
      picks.map((p) => p.label),
      ['Add the check', 'First version'],
    );
  });
});

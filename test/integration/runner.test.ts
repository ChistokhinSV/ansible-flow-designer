// AFD-276 acceptance against an Ansible Flow Server (skipped without AFD_RUNNER_URL,
// AFD_RUNNER_TOKEN and AFD_RUNNER_WORKSPACE, a workspace the token's owner administers). Each run
// makes a hosted project there (the test workspace has new history each time, and the server
// never rewrites a project's branch) and pushes the test workspace to it through the server's git
// address, which becomes the repository's remote: Run on Server finds the project by that alone.
// A launch configuration for the Hello sample is made. Then Run on Server: the token check, and a
// check run followed to its end with the hosts on the canvas, at the commit the workspace has.
import * as assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as vscode from 'vscode';
import type { RunView } from '../../src/core/protocol';
import { closeAll, flowUri, openDesigner, testApi } from './helpers';

const url = process.env.AFD_RUNNER_URL?.replace(/\/+$/, '');
const token = process.env.AFD_RUNNER_TOKEN;
const workspace = process.env.AFD_RUNNER_WORKSPACE;
const FLOW = flowUri('hello');
const FILE = 'flows/hello/hello.flow.yaml';

const api = async (method: string, path: string, body?: unknown) => {
  const res = await fetch(`${url}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: res.status, json: (await res.json().catch(() => undefined)) as unknown };
};

describe('AFD-276: Run on Server (Ansible Flow Server)', function () {
  this.timeout(600_000);
  let head = '';

  before(async function () {
    if (!url || !token || !workspace) this.skip();
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath as string;
    const ws = workspace;
    const key = `vscode-${Date.now()}`;
    const made = await api('POST', `/api/v1/workspaces/${ws}/projects`, { key, name: key });
    assert.equal(made.status, 201, JSON.stringify(made.json));
    const id = (made.json as { id: string }).id;
    const git = (...args: string[]) =>
      execFileSync('git', args, { cwd: root, encoding: 'utf8', timeout: 60_000 }).trim();
    const remote = `${url}/git/${ws}/${key}.git`;
    try {
      git('remote', 'remove', 'afs');
    } catch {
      // Not there yet.
    }
    // The token goes in a header for this push only, never into the repository's config.
    git('remote', 'add', 'afs', remote);
    git(
      '-c',
      `http.extraHeader=Authorization: Bearer ${token}`,
      'push',
      '--quiet',
      'afs',
      'HEAD:main',
    );
    head = git('rev-parse', 'HEAD');
    const config = await api('POST', `/api/v1/projects/${id}/launch-configs`, {
      name: 'Hello from VS Code',
      flowFile: FILE,
      mode: 'check',
    });
    assert.equal(config.status, 201, JSON.stringify(config.json));
    await openDesigner(FLOW);
  });
  after(async () => {
    await vscode.commands.executeCommand('afd.runner.clearToken', FLOW);
    await closeAll();
  });

  it('a token is checked before it is stored', async () => {
    const t = await testApi();
    assert.match((await t.runnerToken(FLOW, 'afs_not-a-real-token')) ?? '', /token/i);
    assert.equal(await t.runnerToken(FLOW, token as string), undefined);
  });

  it('runs the flow on the server at this commit, followed on the canvas to its end', async () => {
    const t = await testApi();
    const run: RunView = await t.runnerLaunch(FLOW, {
      inputs: { devices: ['localhost'] },
      mode: 'check',
    });
    assert.equal(run.source, 'runner');
    assert.equal(run.state, 'done', run.error);
    assert.equal(run.rc, 0);
    assert.equal(run.runner?.commit, head);
    assert.equal(run.runner?.drift, undefined);
    assert.ok(run.runner?.url.startsWith(`${url}/runs/`));
    // Every step shows the host on the canvas. (The summary's own host list stays empty when the
    // target is Ansible's implicit localhost: AFD-281.)
    const steps = Object.values(run.summary?.nodes ?? {});
    assert.ok(steps.length >= 3, JSON.stringify(run.summary));
    assert.ok(
      steps.every((n) => n.ok_hosts?.includes('localhost')),
      JSON.stringify(steps),
    );
  });

  it('AFD-282: checks uncommitted work on the server as a dev run', async () => {
    const t = await testApi();
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath as string;
    const file = vscode.Uri.joinPath(vscode.Uri.file(root), FILE);
    const before = new TextDecoder().decode(await vscode.workspace.fs.readFile(file));
    // An uncommitted change: the step's title, which the run's output then shows.
    const changed = before.replace('title: Say hello', 'title: Say hello, from my work');
    assert.notEqual(changed, before);
    await vscode.workspace.fs.writeFile(file, new TextEncoder().encode(changed));
    try {
      const run: RunView = await t.runnerLaunch(FLOW, {
        inputs: { devices: ['localhost'] },
        dev: true,
      });
      assert.equal(run.state, 'done', run.error);
      assert.equal(run.mode, 'check');
      assert.equal(run.runner?.dev, true);
      assert.notEqual(run.runner?.commit, head);
      const output = await (
        await fetch(`${url}/api/v1/runs/${run.runner?.runId}/output`, {
          headers: { authorization: `Bearer ${token}` },
        })
      ).text();
      assert.match(output, /Say hello, from my work/);
    } finally {
      await vscode.workspace.fs.writeFile(file, new TextEncoder().encode(before));
    }
  });
});

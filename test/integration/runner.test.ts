// AFD-276 acceptance against an Ansible Flow Server (skipped without AFD_RUNNER_URL,
// AFD_RUNNER_TOKEN and AFD_RUNNER_WORKSPACE, a workspace the token's owner administers). Each run
// makes a hosted project there (the test workspace has new history each time, and the server
// never rewrites a project's branch) and pushes the test workspace to it through the server's git
// address, which becomes the repository's remote: Run on Server finds the project by that alone.
// A launch configuration for the Hello sample is made. Then Run on Server: the token check, and a
// check run followed to its end with the hosts on the canvas, at the commit the workspace has.
import * as assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import * as http from 'node:http';
import * as https from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as vscode from 'vscode';
import type { RunView } from '../../src/core/protocol';
import {
  commitAndPush,
  folderIsEmpty,
  getProjectFlows,
  pullBranch,
  sendFolder,
} from '../../src/node/runner/projectGit';
import { closeAll, flowUri, openDesigner, testApi } from './helpers';

const url = process.env.AFD_RUNNER_URL?.replace(/\/+$/, '');
const token = process.env.AFD_RUNNER_TOKEN;
const workspace = process.env.AFD_RUNNER_WORKSPACE;
// AFD-301: a lab server with a self-signed certificate (the server's e2e stack): git and the
// test's own requests do not check it, and Connect turns verification off as its warning offers.
const lab = process.env.AFD_RUNNER_LAB === '1';
if (lab) process.env.GIT_SSL_NO_VERIFY = '1';
const FLOW = flowUri('hello');
const FILE = 'flows/hello/hello.flow.yaml';
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

const api = (method: string, path: string, body?: unknown) =>
  new Promise<{ status: number; json: unknown; text: string }>((resolve, reject) => {
    const target = new URL(`${url}${path}`);
    const data = body === undefined ? undefined : JSON.stringify(body);
    const req = (target.protocol === 'https:' ? https : http).request(
      target,
      {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          ...(data ? { 'content-type': 'application/json' } : {}),
        },
        ...(target.protocol === 'https:' ? { rejectUnauthorized: !lab } : {}),
      },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (c) => {
          text += c;
        });
        res.on('end', () => {
          let json: unknown;
          try {
            json = JSON.parse(text);
          } catch {
            json = undefined;
          }
          resolve({ status: res.statusCode ?? 0, json, text });
        });
      },
    );
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });

describe('AFD-276: Run on Server (Ansible Flow Server)', function () {
  this.timeout(600_000);
  let head = '';
  let key = '';

  before(async function () {
    if (!url || !token || !workspace) this.skip();
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath as string;
    const ws = workspace;
    key = `vscode-${Date.now()}`;
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

  it('AFD-301: Disconnect forgets the server; Connect finds the project from the git remote', async () => {
    const t = await testApi();
    assert.equal(await t.runnerDisconnect(FLOW), undefined);
    assert.deepEqual(await t.serverState(FLOW), { connected: false });
    // A token the server does not take is refused, and nothing is kept.
    assert.match(
      (await t.runnerConnect(FLOW, {
        url: url as string,
        token: 'afs_not-a-real-token',
        labCertificate: lab,
      })) ?? '',
      /not accepted/,
    );
    assert.equal((await t.serverState(FLOW)).connected, false);
    assert.equal(
      await t.runnerConnect(FLOW, {
        url: url as string,
        token: token as string,
        labCertificate: lab,
      }),
      undefined,
    );
    const state = await t.serverState(FLOW);
    assert.equal(state.connected, true);
    assert.equal(state.url, url);
    // The test workspace's remote `afs` is the server's git address of the project.
    assert.equal(state.project, `${workspace}/${key}`);
    assert.equal(state.pane, `${new URL(url as string).host} · ${workspace}/${key}`);
  });

  it("AFD-303: the Flows pane says which flows are the server project's", async () => {
    const t = await testApi();
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath as string;
    const first = await t.serverFlows(FLOW);
    assert.ok(first, 'no server state');
    assert.equal(first.repo, true);
    assert.equal(first.behind, false);
    assert.equal(first.states[FILE], 'same');
    assert.deepEqual(first.missing, []);
    const path = join(root, FILE);
    const before = readFileSync(path, 'utf8');
    const mine = join(root, 'flows', 'mine.flow.yaml');
    try {
      writeFileSync(path, `${before}# changed here\n`);
      writeFileSync(mine, before);
      // The pane's list of flows follows the file watcher: asked again until it has the new one.
      let now = await t.serverFlows(FLOW);
      for (let i = 0; i < 20 && !now?.states['flows/mine.flow.yaml']; i++) {
        await pause(250);
        now = await t.serverFlows(FLOW);
      }
      assert.equal(now?.states[FILE], 'changed');
      assert.equal(now?.states['flows/mine.flow.yaml'], 'local');
    } finally {
      writeFileSync(path, before);
      rmSync(mine, { force: true });
    }
  });

  it("AFD-318: Change Project in a project's git copy gets the other project into a new folder", async () => {
    const t = await testApi();
    const auth = { token: token as string, verifyTls: !lab };
    const mine = `${workspace}/${key}`;
    const src = mkdtempSync(join(tmpdir(), 'afd-318-src-'));
    const place = mkdtempSync(join(tmpdir(), 'afd-318-place-'));
    const ident = {
      GIT_AUTHOR_NAME: 'AFD Test',
      GIT_AUTHOR_EMAIL: 'afd-test@example.net',
      GIT_COMMITTER_NAME: 'AFD Test',
      GIT_COMMITTER_EMAIL: 'afd-test@example.net',
    };
    Object.assign(process.env, ident);
    const settings = vscode.workspace.getConfiguration('afd', FLOW);
    try {
      const otherKey = `other-${Date.now()}`;
      const made = await api('POST', `/api/v1/workspaces/${workspace}/projects`, {
        key: otherKey,
        name: 'other',
      });
      assert.equal(made.status, 201, JSON.stringify(made.json));
      const project = made.json as { gitPath: string; gitRef: string };
      writeFileSync(join(src, 'b.flow.yaml'), 'schema_version: 2\n');
      await sendFolder(src, `${url}${project.gitPath}`, project.gitRef, auth, true);
      const other = `${workspace}/${otherKey}`;
      // The setting naming another project does not move the folder: its remote decides.
      await settings.update('runner.project', other, vscode.ConfigurationTarget.Workspace);
      assert.equal((await t.serverState(FLOW)).project, mine);
      assert.equal((await t.serverFlows(FLOW))?.behind, false);
      await settings.update('runner.project', mine, vscode.ConfigurationTarget.Workspace);
      // Change Project: the other one into <place>/<key>, set for the server; this folder stays.
      assert.equal(await t.runnerChangeProject(FLOW, { project: other, into: place }), undefined);
      const copy = join(place, otherKey);
      assert.equal(readFileSync(join(copy, 'b.flow.yaml'), 'utf8'), 'schema_version: 2\n');
      assert.deepEqual(JSON.parse(readFileSync(join(copy, '.vscode', 'settings.json'), 'utf8')), {
        'afd.runner.url': url,
        'afd.runner.project': other,
      });
      assert.equal((await t.serverState(FLOW)).project, mine);
      assert.equal(settings.get('runner.project'), mine);
      // Picking the project the folder is a copy of only sets it.
      assert.equal(await t.runnerChangeProject(FLOW, { project: mine }), undefined);
    } finally {
      for (const name of Object.keys(ident)) delete process.env[name];
      for (const dir of [src, place])
        try {
          rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
        } catch {
          // Left in the temporary folder.
        }
    }
  });

  it('AFD-304: Commit & Push from one copy of a project, Pull into another, the token only in the call', async () => {
    const auth = { token: token as string, verifyTls: !lab };
    const ident = {
      GIT_AUTHOR_NAME: 'AFD Test',
      GIT_AUTHOR_EMAIL: 'afd-test@example.net',
      GIT_COMMITTER_NAME: 'AFD Test',
      GIT_COMMITTER_EMAIL: 'afd-test@example.net',
    };
    Object.assign(process.env, ident);
    const one = mkdtempSync(join(tmpdir(), 'afd-304-one-'));
    const two = mkdtempSync(join(tmpdir(), 'afd-304-two-'));
    try {
      const made = await api('POST', `/api/v1/workspaces/${workspace}/projects`, {
        key: `sync-${Date.now()}`,
        name: 'sync',
      });
      assert.equal(made.status, 201, JSON.stringify(made.json));
      const project = made.json as { id: string; gitPath: string; gitRef: string };
      const remote = `${url}${project.gitPath}`;
      // One copy sends a first flow; the other gets it.
      writeFileSync(join(one, 'a.flow.yaml'), 'schema_version: 2\n');
      await sendFolder(one, remote, project.gitRef, auth, true);
      await getProjectFlows(two, remote, project.gitRef, auth);
      // A change in one copy, committed and pushed (one flow only: the other file stays out).
      writeFileSync(join(one, 'a.flow.yaml'), 'schema_version: 2\n# changed\n');
      writeFileSync(join(one, 'notes.txt'), 'not sent\n');
      const pushed = await commitAndPush(one, 'Change a', { paths: ['a.flow.yaml'], auth });
      assert.deepEqual(pushed, { committed: true, pushed: `origin/${project.gitRef}` });
      const status = execFileSync('git', ['status', '--porcelain'], { cwd: one, encoding: 'utf8' });
      assert.match(status, /\?\? notes\.txt/);
      // Nothing new to commit still pushes (nothing to send is fine).
      assert.equal(
        (await commitAndPush(one, 'x', { paths: ['a.flow.yaml'], auth })).committed,
        false,
      );
      // The other copy pulls it, with a change of its own kept.
      writeFileSync(join(two, 'mine.txt'), 'local\n');
      assert.equal(await pullBranch(two, auth), `origin/${project.gitRef}`);
      assert.match(readFileSync(join(two, 'a.flow.yaml'), 'utf8'), /# changed/);
      assert.equal(readFileSync(join(two, 'mine.txt'), 'utf8'), 'local\n');
      // Without the token the server refuses: the call above carried it, nothing stored it.
      assert.equal(
        readFileSync(join(two, '.git', 'config'), 'utf8').includes(token as string),
        false,
      );
    } finally {
      for (const name of Object.keys(ident)) delete process.env[name];
      for (const dir of [one, two])
        try {
          rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
        } catch {
          // Left in the temporary folder.
        }
    }
  });

  it("AFD-302: a folder sent to a new project, and another folder gets that project's flows", async () => {
    const auth = { token: token as string, verifyTls: !lab };
    // A folder with a flow of its own, not a repository: made one, committed, sent.
    const own = mkdtempSync(join(tmpdir(), 'afd-302-own-'));
    const copy = mkdtempSync(join(tmpdir(), 'afd-302-copy-'));
    const repo = mkdtempSync(join(tmpdir(), 'afd-302-repo-'));
    const ident = {
      GIT_AUTHOR_NAME: 'AFD Test',
      GIT_AUTHOR_EMAIL: 'afd-test@example.net',
      GIT_COMMITTER_NAME: 'AFD Test',
      GIT_COMMITTER_EMAIL: 'afd-test@example.net',
    };
    Object.assign(process.env, ident);
    try {
      const flow = readFileSync(
        join(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath as string, FILE),
        'utf8',
      );
      mkdirSync(join(own, 'flows'), { recursive: true });
      writeFileSync(join(own, 'flows', 'mine.flow.yaml'), flow);
      const sentKey = `sent-${Date.now()}`;
      const made = await api('POST', `/api/v1/workspaces/${workspace}/projects`, {
        key: sentKey,
        name: sentKey,
      });
      assert.equal(made.status, 201, JSON.stringify(made.json));
      const project = made.json as { id: string; gitPath: string; gitRef: string };
      const remote = `${url}${project.gitPath}`;
      // Not a repository and not allowed to make one: refused, nothing made.
      await assert.rejects(sendFolder(own, remote, project.gitRef, auth, false), /not a git/);
      const sent = await sendFolder(own, remote, project.gitRef, auth, true);
      assert.deepEqual(sent, { remoteName: 'origin', committed: true });
      const there = (await api('GET', `/api/v1/projects/${project.id}`)).json as {
        commit?: string;
      };
      assert.match(there.commit ?? '', /^[0-9a-f]{40}$/);

      // An empty folder (only VS Code's settings) gets the project's flows; its settings stay.
      mkdirSync(join(copy, '.vscode'));
      writeFileSync(join(copy, '.vscode', 'settings.json'), '{}\n');
      assert.equal(folderIsEmpty(copy), true);
      await getProjectFlows(copy, remote, project.gitRef, auth);
      // As git checks it out here (core.autocrlf may turn LF into CRLF).
      const lf = (t: string) => t.split('\r\n').join('\n');
      assert.equal(lf(readFileSync(join(copy, 'flows', 'mine.flow.yaml'), 'utf8')), lf(flow));
      assert.equal(readFileSync(join(copy, '.vscode', 'settings.json'), 'utf8'), '{}\n');
      const origin = execFileSync('git', ['remote', 'get-url', 'origin'], {
        cwd: copy,
        encoding: 'utf8',
      }).trim();
      assert.equal(origin, remote);
      // The token is in no file of the copy.
      assert.equal(
        readFileSync(join(copy, '.git', 'config'), 'utf8').includes(token as string),
        false,
      );
      // A folder that is a repository already is refused, and left as it was.
      execFileSync('git', ['init', '-q'], { cwd: repo });
      await assert.rejects(
        getProjectFlows(repo, remote, project.gitRef, auth),
        /already a git repository/,
      );
    } finally {
      for (const name of Object.keys(ident)) delete process.env[name];
      // Windows may still hold a file of a fresh repository (VS Code's git watches new ones).
      for (const dir of [own, copy, repo])
        try {
          rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
        } catch {
          // Left in the temporary folder.
        }
    }
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
    // Every step shows the host on the canvas, and the run counts it (AFD-281: Ansible's implicit
    // localhost is a host of the run).
    assert.deepEqual(run.summary?.hosts, ['localhost']);
    const steps = Object.values(run.summary?.nodes ?? {});
    assert.ok(steps.length >= 3, JSON.stringify(run.summary));
    assert.ok(
      steps.every((n) => n.ok_hosts?.includes('localhost')),
      JSON.stringify(steps),
    );
  });

  it('AFD-284: a change pushed to the server shows over the canvas; Show changes pulls it', async () => {
    const t = await testApi();
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath as string;
    const remote = `${url}/git/${workspace}/${key}.git`;
    const header = `http.extraHeader=Authorization: Bearer ${token}`;
    const run = (cwd: string, ...args: string[]) =>
      execFileSync('git', args, { cwd, encoding: 'utf8', timeout: 60_000 }).trim();
    // The test workspace pulls from the server: its token for this remote only, in this
    // throwaway repository's config.
    run(root, 'config', `http.${remote}.extraHeader`, `Authorization: Bearer ${token}`);
    run(root, '-c', header, 'fetch', '--quiet', 'afs');
    run(root, 'branch', '--set-upstream-to=afs/main');
    // Someone else changes the flow and pushes it to the server.
    const other = mkdtempSync(join(tmpdir(), 'afd-284-'));
    try {
      run(other, '-c', header, 'clone', '--quiet', remote, '.');
      const path = join(other, FILE);
      writeFileSync(
        path,
        readFileSync(path, 'utf8').replace('title: Say hello', 'title: Say hello to everyone'),
      );
      run(
        other,
        '-c',
        'user.name=Mia Ortega',
        '-c',
        'user.email=mia@example.net',
        'commit',
        '-qam',
        'Friendlier',
      );
      run(other, '-c', header, 'push', '--quiet', 'origin', 'HEAD:main');
    } finally {
      // git's object files are read-only: on Windows they may refuse to go; a temp folder.
      try {
        rmSync(other, { recursive: true, force: true, maxRetries: 5 });
      } catch {
        // left in the temp folder
      }
    }
    // The designer says who changed it and how much.
    const until = Date.now() + 60_000;
    let note = (await t.inspect(FLOW)).server;
    while (!note) {
      assert.ok(Date.now() < until, 'the server note shows');
      await pause(500);
      note = (await t.inspect(FLOW)).server;
    }
    assert.match(note, /Mia Ortega changed this flow on the server: 1 step\./);
    // Show changes: pulled, and the Changes lens compares with the version shown before.
    await t.serverUpdate(FLOW, true);
    assert.equal(run(root, 'rev-parse', 'HEAD'), run(root, 'rev-parse', 'afs/main'));
    const doc = await vscode.workspace.openTextDocument(FLOW);
    const loaded = Date.now() + 15_000;
    while (!doc.getText().includes('title: Say hello to everyone')) {
      assert.ok(Date.now() < loaded, 'the pulled flow is shown');
      await pause(200);
    }
    const compared = Date.now() + 15_000;
    while (t.lensFacts(FLOW).compare?.state !== 'ready') {
      assert.ok(Date.now() < compared, JSON.stringify(t.lensFacts(FLOW).compare));
      await pause(200);
    }
    assert.equal(t.lensFacts(FLOW).compare?.ref, head);
    assert.equal((await t.inspect(FLOW)).server, null);
    t.setLens(FLOW, null);
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
      const output = (await api('GET', `/api/v1/runs/${run.runner?.runId}/output`)).text;
      assert.match(output, /Say hello, from my work/);
    } finally {
      await vscode.workspace.fs.writeFile(file, new TextEncoder().encode(before));
    }
  });
});

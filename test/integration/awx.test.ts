// M7 acceptance against the lab AWX (skipped without AFD_AWX_URL and AFD_AWX_TOKEN): the token
// check, Set Up AWX Template with fixed picks, Launch in AWX with the job's events mapped to the
// ports the flow designs, Run mode on the canvas, and the tested proposal of a passing run. With
// AFD_AWX_GIT_REMOTE the test workspace is pushed to the AWX project's remote first (the lab Git
// server, decision M7-2), so AWX runs exactly this commit.
import * as assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as vscode from 'vscode';
import { parse } from 'yaml';
import type { FlowDocument } from '../../src/core/flow/types';
import type { RunView } from '../../src/core/protocol';
import { testedCandidates } from '../../src/core/run/view';
import { closeAll, flowUri, openDesigner, testApi } from './helpers';

const url = process.env.AFD_AWX_URL;
const token = process.env.AFD_AWX_TOKEN;
const remote = process.env.AFD_AWX_GIT_REMOTE;
const FLOW = flowUri('awx-e2e');
const PICKS = {
  project: 'AFD lab',
  inventory: 'AFD lab',
  environment: 'AFD EE (ansible-core 2.19)',
};

describe('M7 acceptance: Run mode with AWX (lab)', function () {
  this.timeout(600_000);
  let flow: FlowDocument;
  const id = (key: string) => flow.nodes.find((n) => n.key === key)?.id as string;

  before(async function () {
    if (!url || !token) this.skip();
    if (remote) {
      const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath as string;
      execFileSync('git', ['push', '--force', '--quiet', remote, 'HEAD:main'], {
        cwd: root,
        stdio: 'ignore',
        env: { ...process.env, GIT_SSH_COMMAND: process.env.AFD_AWX_GIT_SSH ?? 'ssh' },
        timeout: 60_000,
      });
    }
    const doc = await openDesigner(FLOW);
    flow = parse(doc.getText()) as FlowDocument;
  });
  after(async () => {
    await vscode.commands.executeCommand('afd.awx.clearToken', FLOW);
    await closeAll();
  });

  it('a token is checked before it is stored; the template is created from the picks', async () => {
    const api = await testApi();
    assert.match((await api.awxToken(FLOW, 'not-a-real-token')) ?? '', /token/i);
    assert.equal(await api.awxToken(FLOW, token as string), undefined);
    assert.deepEqual(await api.awxSetup(FLOW, PICKS), { ok: true, template: 'AFD · awx-e2e' });
  });

  it('Launch in AWX: the job events show every host on the port the flow designs', async () => {
    const api = await testApi();
    const run: RunView = await api.awxLaunch(FLOW, { devices: ['h01', 'h02', 'h07'] });
    assert.equal(run.state, 'done', run.error);
    assert.equal(run.source, 'awx');
    // h02 fails `work` and ends at the failed end: the job fails, as designed.
    assert.equal(run.awx?.status, 'failed');
    assert.equal(run.rc, 2);
    assert.ok(run.awx?.url.endsWith(`/#/jobs/playbook/${run.awx?.jobId}/output`));
    if (remote) assert.equal(run.awx?.revisionMismatch, false, run.awx?.revision);
    assert.deepEqual(run.summary?.nodes, {
      [id('probe')]: { ok_hosts: ['h01', 'h02'], unreachable: ['h07'] },
      [id('work')]: { ok_hosts: ['h01'], failed_hosts: ['h02'] },
      [id('exclude')]: { ok_hosts: ['h07'] },
      [id('notify')]: { ok_hosts: ['h02'] },
    });
    assert.deepEqual(run.summary?.outcome, { h02: 'Ended at [failed] Failed (outcome: failed)' });
    assert.deepEqual(testedCandidates(flow, run), []);

    // Run mode on the canvas: node states and host counts on wires.
    api.setMode(FLOW, 'run');
    let dom = await api.inspect(FLOW);
    for (let i = 0; i < 20 && !dom.run; i++) {
      await new Promise((r) => setTimeout(r, 250));
      dom = await api.inspect(FLOW);
    }
    assert.equal(dom.run?.nodes[id('probe')], 'warn');
    assert.equal(dom.run?.nodes[id('exclude')], 'ok');
    const wire = (key: string, port: string) =>
      flow.edges.find((e) => e.from.node === id(key) && e.from.port === port)?.id as string;
    assert.equal(dom.run?.wires[wire('probe', 'ok_hosts')], '2 hosts');
    assert.equal(dom.run?.wires[wire('probe', 'unreachable')], '1 host');
    assert.equal(dom.run?.wires[wire('start', 'ok_hosts')], '3 hosts');
    assert.equal(dom.run?.nodes[id('failed')], 'failed');

    const audit = await api.auditLog();
    const launch = audit.findLast((e) => e.event === 'launch' && e.source === 'awx');
    assert.equal((launch?.awx as { job?: number })?.job, run.awx?.jobId);
    assert.ok(audit.some((e) => e.event === 'finish' && e.job === run.awx?.jobId));
  });

  it('a passing run proposes the implemented nodes it ran as tested', async () => {
    const api = await testApi();
    const run = await api.awxLaunch(FLOW, { devices: ['h01', 'h07'] });
    assert.equal(run.awx?.status, 'successful', run.error);
    assert.equal(run.rc, 0);
    const ids = testedCandidates(flow, run);
    assert.deepEqual(ids.sort(), [id('probe'), id('work')].sort());
    const ack = await api.run(FLOW, {
      kind: 'setStatuses',
      statuses: Object.fromEntries(ids.map((n) => [n, 'tested' as const])),
    });
    assert.ok(ack.ok, ack.error);
    const after = parse(
      vscode.workspace.textDocuments.find((d) => d.uri.toString() === FLOW.toString())?.getText() ??
        '',
    ) as FlowDocument;
    for (const n of ids) assert.equal(after.nodes.find((x) => x.id === n)?.status, 'tested');
  });
});

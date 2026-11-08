// AFD-11 acceptance against the lab AWX (skipped without AFD_AWX_URL and AFD_AWX_TOKEN): Set Up AWX
// Template turns the awx-gate flow into an AWX workflow of segment jobs and an approval node;
// launches are approved, denied (the test decides in AWX, as an approver would) or never reach
// the gate, and every host ends on the ports and outcome the flow designs.
import * as assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as vscode from 'vscode';
import { parse } from 'yaml';
import type { AwxWorkflowJobNode } from '../../src/core/awx/types';
import type { FlowDocument } from '../../src/core/flow/types';
import type { RunView } from '../../src/core/protocol';
import { AwxClient } from '../../src/node/awx/client';
import { closeAll, flowUri, openDesigner, testApi } from './helpers';

const url = process.env.AFD_AWX_URL;
const token = process.env.AFD_AWX_TOKEN;
const remote = process.env.AFD_AWX_GIT_REMOTE;
const FLOW = flowUri('awx-gate');
const PICKS = {
  project: 'AFD lab',
  inventory: 'AFD lab',
  environment: 'AFD EE (ansible-core 2.19)',
};
const WORKFLOW = 'AFD · awx-gate';
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Approves or denies the pending approval of the workflow's newest job, as an AWX approver. */
async function decide(awx: AwxClient, approve: boolean): Promise<void> {
  const wf = await awx.named<{ id: number; name: string }>('workflow_job_templates', WORKFLOW);
  const until = Date.now() + 240_000;
  while (Date.now() < until) {
    const jobs = await awx.get<{ results: { id: number }[] }>(
      `/api/v2/workflow_job_templates/${wf?.id}/workflow_jobs/?order_by=-id&page_size=1`,
    );
    const latest = jobs.results[0];
    if (latest) {
      const nodes = await awx.all<AwxWorkflowJobNode>(
        `/api/v2/workflow_jobs/${latest.id}/workflow_nodes/`,
      );
      const pending = nodes
        .map((n) => n.summary_fields.job)
        .find((j) => j?.type === 'workflow_approval' && j.status === 'pending');
      if (pending) {
        await awx.post(
          `/api/v2/workflow_approvals/${pending.id}/${approve ? 'approve' : 'deny'}/`,
          {},
        );
        return;
      }
    }
    await pause(2000);
  }
  throw new Error('no approval became pending');
}

describe('AFD-11 acceptance: AWX workflow with an approval (lab)', function () {
  this.timeout(900_000);
  let flow: FlowDocument;
  let awx: AwxClient;
  const id = (key: string) => flow.nodes.find((n) => n.key === key)?.id as string;

  before(async function () {
    if (!url || !token) this.skip();
    // AFD-161: the lab AWX is plain http.
    awx = new AwxClient(url, token, { allowHttp: true });
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
    const api = await testApi();
    assert.equal(await api.awxToken(FLOW, token as string), undefined);
  });
  after(async () => {
    if (url && token) await vscode.commands.executeCommand('afd.awx.clearToken', FLOW);
    await closeAll();
  });

  it('Set Up AWX Template creates the segment templates and the workflow', async () => {
    const api = await testApi();
    const setup = await api.awxSetup(FLOW, PICKS);
    assert.equal(setup.ok, true, setup.error);
    assert.equal(setup.template, WORKFLOW);
    // AFD-59: the workflow's survey follows the flow inputs.
    assert.ok(setup.survey === 'written' || setup.survey === 'same', setup.survey);
    const doc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === FLOW.toString());
    assert.deepEqual((parse(doc?.getText() ?? '') as FlowDocument).flow.runtime, {
      kind: 'awx_workflow',
      template: WORKFLOW,
    });
    await doc?.save();
    const wf = await awx.named<{ id: number; name: string }>('workflow_job_templates', WORKFLOW);
    const nodes = await awx.all<{ identifier: string }>(
      `/api/v2/workflow_job_templates/${wf?.id}/workflow_nodes/`,
    );
    assert.deepEqual(nodes.map((n) => n.identifier).sort(), [
      'gate-approved',
      'gate-rejected',
      'start',
      'start.finish',
      'start.gate',
    ]);
  });

  it('approved: the hosts at the gate continue; failures fail in the last segment', async () => {
    const api = await testApi();
    const launching = api.awxLaunch(FLOW, { devices: ['h01', 'h02', 'h07'] });
    await decide(awx, true);
    const run: RunView = await launching;
    assert.equal(run.state, 'done', run.error);
    assert.equal(run.awx?.workflow, true);
    assert.ok(run.awx?.url.endsWith(`/#/jobs/workflow/${run.awx?.jobId}/output`));
    assert.equal(run.awx?.approvals?.[id('gate')]?.status, 'approved');
    assert.deepEqual(
      run.awx?.segments?.map((s) => s.name),
      ['start', 'gate-approved'],
    );
    assert.deepEqual(run.summary?.nodes, {
      [id('probe')]: { ok_hosts: ['h01', 'h02'], unreachable: ['h07'] },
      [id('gate')]: { approved: ['h01', 'h02'] },
      [id('work')]: { ok_hosts: ['h01'], failed_hosts: ['h02'] },
      [id('exclude')]: { ok_hosts: ['h07'] },
      [id('notify')]: { ok_hosts: ['h02'] },
    });
    assert.deepEqual(run.summary?.outcome, { h02: 'Ended at [failed] Failed (outcome: failed)' });
    assert.equal(run.rc, 2);
  });

  it('denied: the hosts at the gate take rejected and stop', async () => {
    const api = await testApi();
    const launching = api.awxLaunch(FLOW, { devices: ['h01'] });
    await decide(awx, false);
    const run: RunView = await launching;
    assert.equal(run.state, 'done', run.error);
    assert.equal(run.awx?.approvals?.[id('gate')]?.status, 'denied');
    assert.deepEqual(
      run.awx?.segments?.map((s) => s.name),
      ['start', 'gate-rejected'],
    );
    assert.deepEqual(run.summary?.nodes?.[id('gate')], { rejected: ['h01'] });
    assert.deepEqual(run.summary?.outcome, { h01: 'Ended at [stopped] Stopped (outcome: failed)' });
  });

  it('nobody reaches the gate: no approval is asked, finish ends the workflow', async () => {
    const api = await testApi();
    const run: RunView = await api.awxLaunch(FLOW, { devices: ['h07'] });
    assert.equal(run.state, 'done', run.error);
    assert.deepEqual(run.awx?.approvals, {});
    assert.deepEqual(
      run.awx?.segments?.map((s) => s.name),
      ['start', 'finish'],
    );
    assert.deepEqual(run.summary?.nodes?.[id('exclude')], { ok_hosts: ['h07'] });
    assert.deepEqual(run.summary?.outcome, {});
    assert.equal(run.awx?.status, 'successful');
    assert.equal(run.rc, 0);
  });
});

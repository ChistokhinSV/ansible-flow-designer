// AWX workflows for flows with top-level approvals (AFD-11, ADR-0016). Set up: one job template per
// segment playbook, then the workflow `AFD · <key>`. Each gated segment leads to an AWX approval
// node (approve: `<gate>-approved`, deny or time out: `<gate>-rejected`) and, when nobody reached
// the gate, to `finish`. Launch follows the workflow job: its segment jobs' events are mapped back
// to nodes like any AWX job, and each approval's state is shown on its node.
import { awxEventsToLines, playNodes } from '../../core/awx/events';
import {
  type AwxJob,
  type AwxJobEvent,
  type AwxNamed,
  type AwxWorkflowJob,
  type AwxWorkflowJobNode,
  FINISHED,
} from '../../core/awx/types';
import type { Route, SegmentFile } from '../../core/engine/types';
import { durationSeconds } from '../../core/engine/util';
import { buildModel } from '../../core/flow/model';
import type { FlowDocument, Ulid } from '../../core/flow/types';
import type { AwxApproval, AwxRunInfo } from '../../core/protocol';
import { type RunSummary, summarizeRun } from '../../core/run/events';
import { TIMEOUTS } from '../timeouts';
import { type AwxClient, StoppedFollowing } from './client';

export const workflowName = (doc: FlowDocument) => `AFD · ${doc.flow.key}`;
export const segmentTemplateName = (doc: FlowDocument, segment: string) =>
  `AFD · ${doc.flow.key} · ${segment}`;
const gateId = (segment: string) => `${segment}.gate`;
const finishId = (segment: string) => `${segment}.finish`;

export interface WorkflowPicks {
  project: AwxNamed;
  inventory: AwxNamed;
  environment?: AwxNamed;
  credentials: AwxNamed[];
  /** Repository paths of the segment playbooks, in segment order. */
  playbooks: string[];
}

/** Creates or updates the segment job templates and the workflow; returns the workflow name. */
export async function setupWorkflow(
  awx: AwxClient,
  doc: FlowDocument,
  segments: SegmentFile[],
  picks: WorkflowPicks,
): Promise<string> {
  const templates = new Map<string, number>();
  for (const [i, s] of segments.entries()) {
    const jt = await awx.upsertTemplate({
      name: segmentTemplateName(doc, s.name),
      description: `Ansible Flow Designer: ${doc.flow.name} (${doc.flow.key}), workflow segment ${s.name}`,
      project: picks.project.id,
      playbook: picks.playbooks[i] as string,
      inventory: picks.inventory.id,
      execution_environment: picks.environment?.id,
      credentials: picks.credentials.map((c) => c.id),
    });
    templates.set(s.name, jt.id);
  }
  const project = await awx.get<{ organization: number | null }>(
    `/api/v2/projects/${picks.project.id}/`,
  );
  const name = workflowName(doc);
  const body = {
    name,
    description: `Ansible Flow Designer: ${doc.flow.name} (${doc.flow.key}), split at its approvals`,
    organization: project.organization,
    ask_variables_on_launch: true,
  };
  const found = await awx.named<AwxNamed>('workflow_job_templates', name);
  const wf = found
    ? await awx.patch<AwxNamed>(`/api/v2/workflow_job_templates/${found.id}/`, body)
    : await awx.post<AwxNamed>('/api/v2/workflow_job_templates/', body);
  // Rebuilt every time, so the workflow always matches the generated segments.
  for (const n of await awx.all<AwxNamed>(
    `/api/v2/workflow_job_templates/${wf.id}/workflow_nodes/`,
  ))
    await awx.request('DELETE', `/api/v2/workflow_job_template_nodes/${n.id}/`);
  const add = (node: Record<string, unknown>) =>
    awx.post<{ id: number }>(`/api/v2/workflow_job_templates/${wf.id}/workflow_nodes/`, node);
  const link = (from: number, kind: 'success' | 'failure', to: number) =>
    awx.post(`/api/v2/workflow_job_template_nodes/${from}/${kind}_nodes/`, { id: to });
  const ids = new Map<string, number>();
  for (const s of segments)
    if (!s.finish)
      ids.set(
        s.name,
        (await add({ identifier: s.name, unified_job_template: templates.get(s.name) })).id,
      );
  const model = buildModel(doc);
  for (const s of segments) {
    const gate = s.gate ? model.nodes.get(s.gate)?.node : undefined;
    const from = ids.get(s.name);
    if (!gate || from === undefined) continue;
    const approval = await add({ identifier: gateId(s.name) });
    await awx.post(`/api/v2/workflow_job_template_nodes/${approval.id}/create_approval_template/`, {
      name: `[${gate.key}] ${gate.title}`,
      description: `${doc.flow.name}: approve to continue with the hosts waiting here`,
      timeout: durationSeconds(gate.settings?.timeout) ?? 0,
    });
    const finish = await add({
      identifier: finishId(s.name),
      unified_job_template: templates.get('finish'),
    });
    await link(from, 'success', approval.id);
    await link(from, 'failure', finish.id);
    const child = (outcome: 'approved' | 'rejected') =>
      segments.find((c) => c.parent === s.name && c.entry?.outcome === outcome)?.name;
    const approved = ids.get(child('approved') ?? '');
    const rejected = ids.get(child('rejected') ?? '');
    if (approved !== undefined) await link(approval.id, 'success', approved);
    if (rejected !== undefined) await link(approval.id, 'failure', rejected);
  }
  return name;
}

/**
 * The segment plays that restore and carry host sets run on localhost outside any node; the empty-
 * gate stop is one of them. Neither is a host of the flow or a failure of one.
 */
export function withoutBookkeeping(summary: RunSummary): RunSummary {
  const routed = Object.values(summary.nodes).some((ports) =>
    Object.values(ports).some((hosts) => hosts.includes('localhost')),
  );
  return {
    ...summary,
    hosts: routed ? summary.hosts : summary.hosts.filter((h) => h !== 'localhost'),
    failures: summary.failures.filter((f) => f.node || f.host !== 'localhost'),
  };
}

export interface WorkflowWatch {
  awx: AwxClient;
  doc: FlowDocument;
  segments: SegmentFile[];
  routes: Record<string, Route>;
  /** Called with every change while the workflow runs. */
  update(state: { info: AwxRunInfo; summary: RunSummary; workflow: AwxWorkflowJob }): void;
  /** Local HEAD, for the revision check. */
  sha?: string;
  /** Asked before each poll: a reason to stop following (the workflow keeps running in AWX). */
  stop?: () => 'cancelled' | 'timeout' | undefined;
  /** The workflow job started (AFD-39: Stop Run cancels it). */
  launched?: (workflowJobId: number) => void;
}

/** Launches the workflow with the inputs and follows it until it and its jobs' events are done. */
export async function runWorkflow(
  watch: WorkflowWatch,
  templateId: number,
  inputs: Record<string, unknown>,
): Promise<{ info: AwxRunInfo; summary: RunSummary; workflow: AwxWorkflowJob }> {
  const { awx, doc } = watch;
  const launched = await awx.post<{ workflow_job: number }>(
    `/api/v2/workflow_job_templates/${templateId}/launch/`,
    { extra_vars: inputs },
  );
  watch.launched?.(launched.workflow_job);
  const plays = playNodes(doc);
  const gates = new Map(
    watch.segments.filter((s) => s.gate).map((s) => [gateId(s.name), s.gate as Ulid]),
  );
  interface Tracked {
    segment: string;
    job: AwxJob;
    events: AwxJobEvent[];
    /** When the job finished; `complete` once AWX stored all its events. */
    ended?: number;
    complete?: boolean;
  }
  const jobs = new Map<number, Tracked>();
  const settledJob = (j: Tracked) =>
    !!j.complete || (j.ended !== undefined && Date.now() - j.ended > TIMEOUTS.awxEventsGrace);
  const approvals: Record<Ulid, AwxApproval> = {};
  let workflow = await awx.get<AwxWorkflowJob>(`/api/v2/workflow_jobs/${launched.workflow_job}/`);
  let ended: number | undefined;

  const state = () => {
    const ordered = [...jobs.entries()].sort(([a], [b]) => a - b).map(([, j]) => j);
    const lines = ordered.map((j) => awxEventsToLines(j.events, plays)).filter(Boolean);
    const revision = ordered[0]?.job.scm_revision || undefined;
    const info: AwxRunInfo = {
      jobId: workflow.id,
      url: `${awx.base}/#/jobs/workflow/${workflow.id}/output`,
      template: workflowName(doc),
      status: workflow.status,
      revision,
      revisionMismatch: !!(revision && watch.sha && revision !== watch.sha),
      workflow: true,
      approvals: { ...approvals },
      segments: ordered.map((j) => ({ name: j.segment, job: j.job.id, status: j.job.status })),
    };
    const summary = withoutBookkeeping(summarizeRun(lines.join('\n'), watch.routes));
    return { info, summary, workflow };
  };

  for (;;) {
    await new Promise((r) => setTimeout(r, TIMEOUTS.awxPoll));
    const why = watch.stop?.();
    if (why)
      throw new StoppedFollowing('workflow', workflow.id, state().info.url, why === 'timeout');
    workflow = await awx.get<AwxWorkflowJob>(`/api/v2/workflow_jobs/${workflow.id}/`);
    const nodes = await awx.all<AwxWorkflowJobNode>(
      `/api/v2/workflow_jobs/${workflow.id}/workflow_nodes/`,
    );
    let changed = false;
    for (const n of nodes) {
      const j = n.summary_fields.job;
      if (!j) continue;
      if (j.type === 'workflow_approval') {
        const node = gates.get(n.identifier);
        if (!node) continue;
        let status: AwxApproval['status'] = 'waiting';
        if (j.status === 'successful') status = 'approved';
        else if (FINISHED.has(j.status)) {
          const a = await awx.get<{ timed_out?: boolean }>(`/api/v2/workflow_approvals/${j.id}/`);
          status = a.timed_out ? 'timed out' : 'denied';
        }
        if (approvals[node]?.status !== status) changed = true;
        approvals[node] = { status, url: `${awx.base}/#/workflow_approvals/${j.id}/details` };
        continue;
      }
      if (j.type !== 'job') continue;
      // Segment nodes are named after their segment; every finish node runs `finish`.
      const segment = n.identifier.endsWith('.finish') ? 'finish' : n.identifier;
      let tracked = jobs.get(j.id);
      if (!tracked) {
        tracked = { segment, job: await awx.job(j.id), events: [] };
        jobs.set(j.id, tracked);
        changed = true;
      }
      if (settledJob(tracked)) continue;
      tracked.job = await awx.job(j.id);
      const fresh = await awx.events(j.id, tracked.events.at(-1)?.counter ?? 0);
      tracked.events.push(...fresh);
      if (fresh.length > 0) changed = true;
      if (FINISHED.has(tracked.job.status)) {
        tracked.ended ??= Date.now();
        tracked.complete = !!(tracked.job as AwxJob & { event_processing_finished?: boolean })
          .event_processing_finished;
        // AWX stores a running job's events out of counter order, so polling `counter__gt` can
        // skip one that lands late: once they are all stored, read them all again.
        if (tracked.complete) tracked.events = await awx.events(j.id, 0);
      }
    }
    if (FINISHED.has(workflow.status)) ended ??= Date.now();
    const settled = [...jobs.values()].every(settledJob);
    if (ended !== undefined && (settled || Date.now() - ended > TIMEOUTS.awxEventsGrace))
      return state();
    if (changed) watch.update(state());
  }
}

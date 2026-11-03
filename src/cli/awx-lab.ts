// Lab bootstrap for Run mode (M7, not shipped): the AWX objects the GNS3 lab needs, created or
// updated idempotently through the extension's own client. Reads AFD_AWX_URL and AFD_AWX_TOKEN
// from the environment or ./.env (never printed). Usage: just awx-lab [--sync]
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import type { AwxNamed, AwxProject } from '../core/awx/types';
import { AwxClient } from '../node/awx/client';

const EE = {
  name: 'AFD EE (ansible-core 2.19)',
  image: 'docker.io/library/afd-awx-ee:2.19',
  pull: 'never',
};
const PROJECT = { name: 'AFD lab', scm_branch: 'main' };
const INVENTORY = 'AFD lab';
const LOCAL =
  'ansible_connection: local\nansible_python_interpreter: "{{ ansible_playbook_python }}"\n';
/** Fictional hosts (decision M7-5): local connection in the job pod; h07 points ssh at a closed port. */
const HOSTS: Record<string, { vars: string; groups: string[] }> = {
  ...Object.fromEntries(
    ['h01', 'h02', 'h03', 'h04', 'h05', 'h06'].map((h) => [h, { vars: LOCAL, groups: ['lab'] }]),
  ),
  h07: {
    vars: 'ansible_connection: ssh\nansible_host: 127.0.0.1\nansible_port: 1\n',
    groups: ['lab'],
  },
  ...Object.fromEntries(
    ['sw-edge-01', 'sw-edge-02', 'sw-edge-03', 'sw-edge-04'].map((h) => [
      h,
      { vars: LOCAL, groups: ['edge'] },
    ]),
  ),
};

function env(): { url: string; token: string } {
  if (existsSync('.env'))
    for (const line of readFileSync('.env', 'utf8').split(/\r?\n/)) {
      const m = /^(AFD_AWX_[A-Z_]+)=(.*)$/.exec(line.trim());
      if (m?.[1] && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
    }
  const url = process.env.AFD_AWX_URL;
  const token = process.env.AFD_AWX_TOKEN;
  if (!url || !token) throw new Error('Set AFD_AWX_URL and AFD_AWX_TOKEN (environment or .env)');
  return { url, token };
}

async function upsert<T extends AwxNamed>(
  awx: AwxClient,
  kind: string,
  body: Record<string, unknown> & { name: string },
): Promise<T> {
  const found = await awx.named<T>(kind, body.name);
  const r = found
    ? await awx.patch<T>(`/api/v2/${kind}/${found.id}/`, body)
    : await awx.post<T>(`/api/v2/${kind}/`, body);
  console.log(`${found ? 'updated' : 'created'} ${kind} ${r.id} ${r.name}`);
  return r;
}

async function main() {
  const { url, token } = env();
  const awx = new AwxClient(url, token);
  console.log(`AWX ${(await awx.ping()).version} at ${awx.base}`);
  const org = await awx.named<AwxNamed>('organizations', 'Default');
  if (!org) throw new Error('No organization "Default"');
  const ee = await upsert<AwxNamed>(awx, 'execution_environments', {
    ...EE,
    organization: null,
    description: 'afd-ee + ansible-runner (docker/afd-awx-ee.Dockerfile)',
  });
  // AFD-76: the lab Git server runs on the AWX VM itself, so its pods reach it at the AWX host;
  // AFD_AWX_GIT_URL names it otherwise.
  const scmUrl = process.env.AFD_AWX_GIT_URL ?? `git://${new URL(url).hostname}/afd-lab.git`;
  const project = await upsert<AwxProject>(awx, 'projects', {
    ...PROJECT,
    scm_url: scmUrl,
    scm_type: 'git',
    organization: org.id,
    scm_update_on_launch: true,
    scm_clean: true,
    default_environment: ee.id,
    description: 'Lab Git server on the AWX VM (lab/ops1-git-daemon.sh)',
  });
  const inv = await upsert<AwxNamed>(awx, 'inventories', {
    name: INVENTORY,
    organization: org.id,
    description: 'Fictional hosts for Ansible Flow Designer runs',
  });
  const groups = new Map<string, number>();
  for (const g of new Set(Object.values(HOSTS).flatMap((h) => h.groups))) {
    const found = (
      await awx.get<{ results: AwxNamed[] }>(`/api/v2/inventories/${inv.id}/groups/?name=${g}`)
    ).results[0];
    groups.set(
      g,
      (found ?? (await awx.post<AwxNamed>(`/api/v2/inventories/${inv.id}/groups/`, { name: g })))
        .id,
    );
  }
  for (const [name, h] of Object.entries(HOSTS)) {
    const found = (
      await awx.get<{ results: AwxNamed[] }>(`/api/v2/inventories/${inv.id}/hosts/?name=${name}`)
    ).results[0];
    const host = found
      ? await awx.patch<AwxNamed>(`/api/v2/hosts/${found.id}/`, { variables: h.vars })
      : await awx.post<AwxNamed>(`/api/v2/inventories/${inv.id}/hosts/`, {
          name,
          variables: h.vars,
        });
    for (const g of h.groups)
      await awx.post(`/api/v2/groups/${groups.get(g)}/hosts/`, { id: host.id });
  }
  console.log(
    `inventory ${inv.id}: ${Object.keys(HOSTS).length} hosts in ${[...groups.keys()].join(', ')}`,
  );
  if (process.argv.includes('--fixtures')) await fixtures(awx, project.id, inv.id, ee.id);
  const record = process.argv.indexOf('--record-import');
  if (record > 0) await recordImport(awx, process.argv[record + 1] ?? 'api.json');
  if (process.argv.includes('--sync')) {
    const update = await awx.post<{ id: number }>(`/api/v2/projects/${project.id}/update/`, {});
    for (;;) {
      const u = await awx.get<{ status: string; result_traceback?: string }>(
        `/api/v2/project_updates/${update.id}/`,
      );
      if (['successful', 'failed', 'error', 'canceled'].includes(u.status)) {
        console.log(`project update ${update.id}: ${u.status}`);
        if (u.status !== 'successful') process.exitCode = 1;
        break;
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}

// ---- M9 import fixtures (AFD-15) ---------------------------------------------------------------

/** A playbook the AFD lab project has (test/fixtures/awx/repo), so imported nodes bind to a file. */
const FIXTURE_PLAYBOOK = 'flows/awx-e2e/generated/awx-e2e.yml';
const FIXTURE_JTS: Record<string, Record<string, unknown>> = {
  precheck: { description: 'Check reachability and free flash before the upgrade' },
  backup: { description: 'Save the running configuration' },
  'install image': { become_enabled: true },
  reload: { timeout: 900 },
  verify: { description: 'Compare the OS version and neighbours with the change ticket' },
  rollback: {},
  'notify on-call': {},
};
const FIXTURE_WORKFLOW = 'AFD fixture · edge upgrade';
const FIXTURE_INNER = 'AFD fixture · upgrade steps';

interface FixtureNode {
  identifier?: string;
  template?: { kind: string; name: string };
  approval?: { name: string; description: string; timeout: number };
  converge?: boolean;
  extra?: Record<string, unknown>;
  success?: string[];
  failure?: string[];
  always?: string[];
}

/** Replaces the workflow's nodes with `nodes` (keyed by a local name), so reruns give one result. */
async function workflow(
  awx: AwxClient,
  body: Record<string, unknown> & { name: string },
  nodes: Record<string, FixtureNode>,
  ids: Map<string, number>,
): Promise<AwxNamed> {
  const wf = await upsert<AwxNamed>(awx, 'workflow_job_templates', body);
  for (const n of await awx.all<AwxNamed>(
    `/api/v2/workflow_job_templates/${wf.id}/workflow_nodes/`,
  ))
    await awx.request('DELETE', `/api/v2/workflow_job_template_nodes/${n.id}/`);
  const made = new Map<string, number>();
  for (const [name, n] of Object.entries(nodes)) {
    const node = await awx.post<{ id: number }>(
      `/api/v2/workflow_job_templates/${wf.id}/workflow_nodes/`,
      {
        ...(n.identifier ? { identifier: n.identifier } : {}),
        ...(n.template
          ? { unified_job_template: ids.get(`${n.template.kind}:${n.template.name}`) }
          : {}),
        all_parents_must_converge: n.converge ?? false,
        ...n.extra,
      },
    );
    if (n.approval)
      await awx.post(
        `/api/v2/workflow_job_template_nodes/${node.id}/create_approval_template/`,
        n.approval,
      );
    made.set(name, node.id);
  }
  for (const [name, n] of Object.entries(nodes))
    for (const kind of ['success', 'failure', 'always'] as const)
      for (const child of n[kind] ?? [])
        await awx.post(`/api/v2/workflow_job_template_nodes/${made.get(name)}/${kind}_nodes/`, {
          id: made.get(child),
        });
  console.log(`workflow ${wf.id} ${wf.name}: ${made.size} nodes`);
  return wf;
}

/**
 * The workflows the import tests read (M9): a nested workflow, an approval with a timeout, a
 * fan-out, an always edge, convergence, a project sync, a node without an identifier, a job
 * template whose playbook is not in the AFD repository, and a survey with a password.
 */
async function fixtures(awx: AwxClient, project: number, inventory: number, ee: number) {
  const ids = new Map<string, number>();
  const cred = await awx.named<AwxNamed>('credentials', 'Demo Credential');
  for (const [short, extra] of Object.entries(FIXTURE_JTS)) {
    const jt = await upsert<AwxNamed>(awx, 'job_templates', {
      name: `AFD fixture · ${short}`,
      job_type: 'run',
      project,
      inventory,
      playbook: FIXTURE_PLAYBOOK,
      execution_environment: ee,
      ask_variables_on_launch: true,
      ask_limit_on_launch: true,
      ask_tags_on_launch: true,
      ...extra,
    });
    ids.set(`job:${short}`, jt.id);
  }
  if (cred) {
    const linked = await awx.all<AwxNamed>(
      `/api/v2/job_templates/${ids.get('job:precheck')}/credentials/`,
    );
    if (!linked.some((c) => c.id === cred.id))
      await awx.post(`/api/v2/job_templates/${ids.get('job:precheck')}/credentials/`, {
        id: cred.id,
      });
  }
  const demo = await awx.named<AwxNamed>('job_templates', 'Demo Job Template');
  if (demo) ids.set('job:demo', demo.id);
  ids.set('project:AFD lab', project);
  const org = await awx.named<AwxNamed>('organizations', 'Default');
  const inner = await workflow(
    awx,
    { name: FIXTURE_INNER, organization: org?.id, description: 'Backup, install and reload' },
    {
      sync: {
        identifier: 'sync',
        template: { kind: 'project', name: 'AFD lab' },
        success: ['install'],
      },
      backup: {
        identifier: 'backup',
        template: { kind: 'job', name: 'backup' },
        success: ['install'],
      },
      install: {
        identifier: 'install',
        template: { kind: 'job', name: 'install image' },
        converge: true,
        success: ['reload'],
      },
      reload: { identifier: 'reload', template: { kind: 'job', name: 'reload' } },
    },
    ids,
  );
  ids.set(`workflow:${FIXTURE_INNER}`, inner.id);
  const outer = await workflow(
    awx,
    {
      name: FIXTURE_WORKFLOW,
      organization: org?.id,
      description: 'Upgrade the edge switches in one maintenance window',
      extra_vars: 'site: edge-lab\n',
      limit: 'edge',
      inventory,
    },
    {
      precheck: {
        identifier: 'precheck',
        template: { kind: 'job', name: 'precheck' },
        extra: { limit: 'edge', job_tags: 'precheck', extra_data: { min_flash_mb: 512 } },
        success: ['approve'],
        failure: ['notify'],
      },
      approve: {
        identifier: 'approve',
        approval: {
          name: 'Approve the upgrade window',
          description: 'Network on-call approves',
          timeout: 1800,
        },
        success: ['upgrade'],
        failure: ['notify'],
      },
      upgrade: {
        identifier: 'upgrade',
        template: { kind: 'workflow', name: FIXTURE_INNER },
        success: ['verify', 'report'],
        failure: ['rollback'],
      },
      verify: { identifier: 'verify', template: { kind: 'job', name: 'verify' } },
      report: { identifier: 'report', template: { kind: 'job', name: 'demo' } },
      rollback: {
        identifier: 'rollback',
        template: { kind: 'job', name: 'rollback' },
        always: ['notify'],
      },
      // No identifier: AWX assigns a UUID, and the import keys the node by its template name.
      notify: { template: { kind: 'job', name: 'notify on-call' } },
    },
    ids,
  );
  await awx.post(`/api/v2/workflow_job_templates/${outer.id}/survey_spec/`, {
    name: '',
    description: '',
    spec: [
      {
        question_name: 'Change ticket',
        variable: 'change_ticket',
        type: 'text',
        required: true,
        default: 'CHG0001234',
      },
      {
        question_name: 'Reboot wait (s)',
        variable: 'reboot_wait',
        type: 'integer',
        required: false,
        default: 300,
        min: 0,
        max: 3600,
      },
      {
        question_name: 'Image',
        variable: 'image',
        type: 'multiplechoice',
        required: true,
        default: '17.9.4',
        choices: ['17.9.4', '17.12.2'],
      },
      {
        question_name: 'Enable password',
        variable: 'lab_enable_password',
        type: 'password',
        required: false,
        default: 'fictional-lab-only',
      },
    ],
  });
  await awx.patch(`/api/v2/workflow_job_templates/${outer.id}/`, { survey_enabled: true });
}

/** Fields the import reads; values under VALUE_KEYS are kept whole. */
const KEEP = new Set([
  'id',
  'name',
  'description',
  'extra_vars',
  'limit',
  'survey_enabled',
  'spec',
  'variable',
  'type',
  'required',
  'default',
  'question_name',
  'choices',
  'min',
  'max',
  'identifier',
  'summary_fields',
  'unified_job_template',
  'unified_job_type',
  'timeout',
  'success_nodes',
  'failure_nodes',
  'always_nodes',
  'all_parents_must_converge',
  'extra_data',
  'job_tags',
  'playbook',
  'become_enabled',
  'ask_credential_on_launch',
  'project',
  'execution_environment',
  'credentials',
  'kind',
]);
const VALUE_KEYS = new Set(['extra_data', 'extra_vars', 'default', 'choices']);

function trim(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(trim);
  if (!v || typeof v !== 'object') return v;
  return Object.fromEntries(
    Object.entries(v)
      .filter(([k]) => KEEP.has(k))
      .map(([k, x]) => [k, VALUE_KEYS.has(k) ? x : trim(x)]),
  );
}

/** Records the API answers the import of the fixture workflow reads (unit test fixture). */
async function recordImport(awx: AwxClient, file: string) {
  const { workflowFromApi } = await import('../core/awx/workflow');
  const wf = await awx.named<AwxNamed>('workflow_job_templates', FIXTURE_WORKFLOW);
  if (!wf) throw new Error(`No workflow "${FIXTURE_WORKFLOW}": run with --fixtures first`);
  const answers: Record<string, unknown> = {};
  await workflowFromApi(
    {
      get: async <T>(path: string) => {
        const r = await awx.get<T>(path);
        answers[path] = trim(r);
        return r;
      },
      all: async <T>(path: string) => {
        const r = await awx.all<T>(path);
        answers[path] = trim(r);
        return r;
      },
    },
    wf.id,
  );
  writeFileSync(file, `${JSON.stringify(answers, null, 2)}\n`);
  console.log(`recorded ${Object.keys(answers).length} answers for workflow ${wf.id} to ${file}`);
}

main().catch((e: Error) => {
  console.error(e.message);
  process.exitCode = 1;
});

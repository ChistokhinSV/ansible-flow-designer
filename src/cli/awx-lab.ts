// Lab bootstrap for Run mode (M7, not shipped): the AWX objects the GNS3 lab needs, created or
// updated idempotently through the extension's own client. Reads AFD_AWX_URL and AFD_AWX_TOKEN
// from the environment or ./.env (never printed). Usage: just awx-lab [--sync]
import { existsSync, readFileSync } from 'node:fs';
import type { AwxNamed, AwxProject } from '../core/awx/types';
import { AwxClient } from '../extension/awx/client';

const EE = {
  name: 'AFD EE (ansible-core 2.19)',
  image: 'docker.io/library/afd-awx-ee:2.19',
  pull: 'never',
};
const PROJECT = { name: 'AFD lab', scm_url: 'git://10.10.10.10/afd-lab.git', scm_branch: 'main' };
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
  const project = await upsert<AwxProject>(awx, 'projects', {
    ...PROJECT,
    scm_type: 'git',
    organization: org.id,
    scm_update_on_launch: true,
    scm_clean: true,
    default_environment: ee.id,
    description: 'Lab Git server on ops1 (lab/ops1-git-daemon.sh)',
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

main().catch((e: Error) => {
  console.error(e.message);
  process.exitCode = 1;
});

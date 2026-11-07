// Round 4's fictional workspace (AFD-109, variant D), built with the flow tools' own code as rounds
// 1-3 are, so every flow is valid for the build under test and generated/ comes from its engine.
// The health, upgrade, audit and pipeline flows reuse the shared builders with variant D's names.
import { readFileSync, writeFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { type FlowIO, flowEdit, flowValidate } from '../../../src/core/ai/handlers';
import { createIdFactory } from '../../../src/core/flow/ids';
import { createSchemaValidator } from '../../../src/core/flow/schema';
import type { ImplBinding } from '../../../src/core/flow/types';
import { FsFlowIO } from '../../../src/mcp/fsIO';
import { colleagueCommit } from '../git';
import type { OutsideChange, SessionDirs } from '../study';
import {
  assertThat,
  audit,
  build,
  chain,
  debug,
  end,
  health,
  must,
  outsideEdit,
  pipeline,
  seededIds,
  upgrade,
} from '../workspace';
import { D, type ModuleStep } from './data';

export const EDGE = 'flows/edge';
export const PLATFORM = 'flows/platform';

const bound = (s: ModuleStep): ImplBinding => ({
  kind: 'module',
  ref: s.module,
  params: { ...s.params },
});

/** D2-D6: every step bound; the wait step has a 30 s timeout and no retry yet. */
async function pool(io: FlowIO) {
  const p = D.pool;
  const path = `${EDGE}/${p.key}.flow.yaml`;
  await build(io, path, p.name, p.goal, [
    end('stopped', 'Stopped', 'failed'),
    ...chain(
      'start.ok_hosts',
      [p.readKey, p.readState, p.disable, p.wait, p.report].map((s) => ({ ...s, impl: bound(s) })),
      'stopped',
    ),
  ]);
  await must(
    `${path} timeout`,
    flowEdit(io, {
      path,
      ops: [{ op: 'update_node', node: p.wait.key, settings: { timeout: p.timeout } }],
    }),
  );
}

/** D7: two checks that fail on hosts in both data centres. */
async function dns(io: FlowIO) {
  const d = D.dns;
  await build(io, `${EDGE}/${d.key}.flow.yaml`, d.name, d.goal, [
    end('stopped', 'Stopped', 'failed'),
    ...chain(
      'start.ok_hosts',
      [
        { ...d.serial, impl: assertThat(d.serial.that, d.serial.failMsg) },
        { ...d.resolver, impl: assertThat(d.resolver.that, d.resolver.failMsg) },
        { ...d.push, impl: debug(d.push.msg) },
        { ...d.reload, impl: debug(d.reload.msg) },
      ],
      'stopped',
    ),
  ]);
}

/** D1: a generated playbook someone fixed by hand instead of the flow. */
async function renewal(io: FlowIO, root: string) {
  const r = D.renewal;
  await build(io, `${PLATFORM}/${r.key}.flow.yaml`, r.name, r.goal, [
    end('stopped', 'Stopped', 'failed'),
    ...chain(
      'start.ok_hosts',
      [{ ...r.list, impl: bound(r.list) }, ...r.steps.map((s) => ({ ...s, impl: debug(s.msg) }))],
      'stopped',
    ),
  ]);
  const file = join(root, PLATFORM, 'generated', `${r.key}.yml`);
  const text = readFileSync(file, 'utf8');
  if (!text.includes(r.handEdit.from))
    throw new Error(`${file} has no "${r.handEdit.from}" to edit by hand`);
  writeFileSync(file, text.replace(r.handEdit.from, r.handEdit.to));
}

async function files(root: string) {
  await mkdir(join(root, 'inventory'), { recursive: true });
  await writeFile(
    join(root, 'ansible.cfg'),
    '[defaults]\ninventory = inventory/lab.ini\nhost_key_checking = False\nretry_files_enabled = False\n',
  );
  const vars = (name: string) =>
    Object.entries(D.hosts.find((h) => h.name === name)?.vars ?? {})
      .map(([k, x]) => `${k}=${x}`)
      .join(' ');
  const lines = [
    '# Fictional lab load balancers in two data centres. Every host uses the local connection: nothing leaves the machine.',
    ...Object.entries(D.groups).flatMap(([group, hosts]) => [
      `[${group}]`,
      ...hosts.map((h) => `${h} ${vars(h)}`),
      '',
    ]),
    '[lab:children]',
    ...Object.keys(D.groups),
    '',
    '[lab:vars]',
    'ansible_connection=local',
    'ansible_python_interpreter="{{ ansible_playbook_python }}"',
    '',
  ];
  await writeFile(join(root, 'inventory', 'lab.ini'), lines.join('\n'));
  await writeFile(
    join(root, 'README.md'),
    `# ${D.repo}\n\nA fictional automation repository for an Ansible Flow Designer usability session. The load balancers in \`inventory/lab.ini\` use the local connection, so runs never reach a real device.\n`,
  );
}

/** Writes the workspace into `root` (an empty folder); returns one problems line per flow. */
export async function buildRound4(root: string): Promise<string[]> {
  const io = new FsFlowIO([root], createSchemaValidator(), seededIds(109));
  await files(root);
  for (const dir of [EDGE, PLATFORM]) await mkdir(join(root, dir), { recursive: true });
  await pool(io);
  await dns(io);
  await health(io, D, root, EDGE);
  await upgrade(io, D, EDGE);
  await audit(io, D, root, EDGE);
  await renewal(io, root);
  await pipeline(io, D);
  const lines: string[] = [];
  for (const path of await io.list())
    lines.push((await flowValidate(io, { path })).text.split('\n')[0] ?? path);
  return lines;
}

/** The colleague's edit to the upgrade flow (D10): three step changes and one settings change. */
export async function colleagueEdit(io: FlowIO): Promise<void> {
  await outsideEdit(io, D, EDGE);
  const t = D.retimed;
  await must(
    'colleague retime',
    flowEdit(io, {
      path: `${EDGE}/${D.upgrade.key}.flow.yaml`,
      ops: [{ op: 'update_node', node: t.node, settings: { retries: t.retries, delay: t.delay } }],
    }),
  );
}

/**
 * D10: the participant's work so far is committed, then M. Lindqvist's change to the upgrade flow
 * arrives as a commit of theirs, the way a Git pull brings it, while the flow is closed.
 */
export async function colleagueChange(dirs: SessionDirs): Promise<OutsideChange> {
  return colleagueCommit(
    dirs,
    `${EDGE}/${D.upgrade.key}.flow.yaml`,
    D.colleague,
    'LB upgrade: check the health probes after moving the VIPs; VIP check covers certificates',
    () => colleagueEdit(new FsFlowIO([dirs.workspace], createSchemaValidator(), createIdFactory())),
  );
}

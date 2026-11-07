// Round 3's fictional workspace (AFD-99, variant C), built with the flow tools' own code as rounds 1
// and 2 are, so every flow is valid for the build under test and generated/ comes from its engine.
// The health, upgrade, audit and pipeline flows reuse round 2's builders with variant C's names.
import { readFileSync, writeFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { type FlowIO, flowEdit, flowNew, flowValidate } from '../../../src/core/ai/handlers';
import type { Op } from '../../../src/core/ai/ops';
import { createIdFactory } from '../../../src/core/flow/ids';
import { createSchemaValidator } from '../../../src/core/flow/schema';
import type { ImplBinding } from '../../../src/core/flow/types';
import { FsFlowIO } from '../../../src/mcp/fsIO';
import { colleagueCommit } from '../git';
import type { OutsideChange, SessionDirs } from '../study';
import {
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
import { C, type ModuleStep } from './data';

const SECURITY = 'flows/security';
const PLATFORM = 'flows/platform';

const bound = (s: ModuleStep): ImplBinding => ({
  kind: 'module',
  ref: s.module,
  params: { ...s.params },
});

async function baseline(io: FlowIO) {
  const b = C.baseline;
  await build(io, `${SECURITY}/${b.key}.flow.yaml`, b.name, b.goal, [
    end('stopped', 'Stopped', 'failed'),
    ...chain(
      'start.ok_hosts',
      [{ ...b.check, impl: debug(b.check.msg) }, b.banner, { ...b.save, impl: debug(b.save.msg) }],
      'stopped',
    ),
  ]);
}

async function deploy(io: FlowIO) {
  const d = C.deploy;
  await build(io, `${SECURITY}/${d.key}.flow.yaml`, d.name, d.goal, [
    end('stopped', 'Stopped', 'failed'),
    ...chain(
      'start.ok_hosts',
      [d.push, d.wait, d.read, d.report].map((s) => ({ ...s, impl: bound(s) })),
      'stopped',
    ),
  ]);
}

async function backup(io: FlowIO) {
  const b = C.backup;
  await build(io, `${PLATFORM}/${b.key}.flow.yaml`, b.name, b.goal, [
    end('stopped', 'Stopped', 'failed'),
    ...chain(
      'start.ok_hosts',
      [b.readKey, b.exportZones, b.upload].map((s) => ({ ...s, impl: bound(s) })),
      'stopped',
    ),
  ]);
}

/** T11: three required inputs whose short names only their descriptions explain. */
async function rollout(io: FlowIO) {
  const r = C.rollout;
  const path = `${SECURITY}/${r.key}.flow.yaml`;
  await must(`${path} new`, flowNew(io, { path, name: r.name, goal: r.goal }));
  await must(
    `${path} edit`,
    flowEdit(io, {
      path,
      ops: [
        ...Object.entries(r.inputs).map(
          ([name, f]): Op => ({
            op: 'set_io',
            node: 'flow',
            side: 'inputs',
            name,
            field: { type: 'string', required: true, description: f.description },
          }),
        ),
        end('stopped', 'Stopped', 'failed'),
        ...r.steps.flatMap((s, i) =>
          chain(
            i === 0 ? 'start.ok_hosts' : `${r.steps[i - 1]?.key}.ok_hosts`,
            [{ ...s, impl: debug(s.msg) }],
            'stopped',
            () => ({
              inputs: Object.fromEntries(
                s.reads.map((n) => [n, { type: 'string' as const, from: `flow.${n}` }]),
              ),
            }),
          ),
        ),
      ],
    }),
  );
}

/** T13, T14: a generated playbook someone fixed by hand instead of the flow. */
async function rotation(io: FlowIO, root: string) {
  const r = C.rotation;
  await build(io, `${PLATFORM}/${r.key}.flow.yaml`, r.name, r.goal, [
    end('stopped', 'Stopped', 'failed'),
    ...chain(
      'start.ok_hosts',
      [{ ...r.find, impl: bound(r.find) }, ...r.steps.map((s) => ({ ...s, impl: debug(s.msg) }))],
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
  await mkdir(join(root, SECURITY, 'files'), { recursive: true });
  await writeFile(
    join(root, 'ansible.cfg'),
    '[defaults]\ninventory = inventory/lab.ini\nhost_key_checking = False\nretry_files_enabled = False\n',
  );
  const vars = (name: string) =>
    Object.entries(C.hosts.find((h) => h.name === name)?.vars ?? {})
      .map(([k, x]) => `${k}=${x}`)
      .join(' ');
  const lines = [
    '# Fictional lab firewalls in two sites. Every host uses the local connection: nothing leaves the machine.',
    ...Object.entries(C.groups).flatMap(([group, hosts]) => [
      `[${group}]`,
      ...hosts.map((h) => `${h} ${vars(h)}`),
      '',
    ]),
    '[lab:children]',
    ...Object.keys(C.groups),
    '',
    '[lab:vars]',
    'ansible_connection=local',
    'ansible_python_interpreter="{{ ansible_playbook_python }}"',
    '',
  ];
  await writeFile(join(root, 'inventory', 'lab.ini'), lines.join('\n'));
  await writeFile(
    join(root, SECURITY, 'files', 'edge.rules'),
    '# Fictional edge rule set for the usability session.\nallow tcp 443 from any to dmz\n',
  );
  await writeFile(
    join(root, 'README.md'),
    `# ${C.repo}\n\nA fictional automation repository for an Ansible Flow Designer usability session. The firewalls in \`inventory/lab.ini\` use the local connection, so runs never reach a real device.\n`,
  );
}

/** Writes the workspace into `root` (an empty folder); returns one problems line per flow. */
export async function buildRound3(root: string): Promise<string[]> {
  const io = new FsFlowIO([root], createSchemaValidator(), seededIds(99));
  await files(root);
  for (const dir of [SECURITY, PLATFORM]) await mkdir(join(root, dir), { recursive: true });
  await baseline(io);
  await deploy(io);
  await backup(io);
  await health(io, C, root, SECURITY);
  await rollout(io);
  await upgrade(io, C, SECURITY);
  await audit(io, C, root);
  await rotation(io, root);
  await pipeline(io, C);
  const lines: string[] = [];
  for (const path of await io.list())
    lines.push((await flowValidate(io, { path })).text.split('\n')[0] ?? path);
  return lines;
}

/**
 * T16: the participant's work so far is committed, then a colleague's change to the upgrade flow
 * arrives as a commit of theirs, the way a Git pull brings it: the file changes on disk and the
 * history shows who changed what.
 */
export async function colleagueChange(dirs: SessionDirs): Promise<OutsideChange> {
  const file = `${SECURITY}/${C.upgrade.key}.flow.yaml`;
  return colleagueCommit(
    dirs,
    file,
    C.colleague,
    'Firewall upgrade: check the session table after failover; policy check covers NAT',
    async () => {
      const io = new FsFlowIO([dirs.workspace], createSchemaValidator(), createIdFactory());
      await outsideEdit(io, C, SECURITY);
    },
  );
}

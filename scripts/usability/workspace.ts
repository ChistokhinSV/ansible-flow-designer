// The fictional repository a usability session works in (AFD-78). Built with the flow tools' own
// code (flow_new, flow_edit through FsFlowIO), so every flow is valid for the build under test and
// its generated/ code comes from the same engine. Two variants with the same structure and other
// names: A for round 1, B for round 2, so a second session does not recall answers. Round 3
// (variant C, round3/) reuses the builders exported here.
import { readFileSync, writeFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { monotonicFactory } from 'ulid';
import { type FlowIO, flowEdit, flowNew, flowValidate } from '../../src/core/ai/handlers';
import type { Op } from '../../src/core/ai/ops';
import { createIdFactory, type IdFactory } from '../../src/core/flow/ids';
import { createSchemaValidator } from '../../src/core/flow/schema';
import type { ImplBinding, Ulid } from '../../src/core/flow/types';
import { FsFlowIO } from '../../src/mcp/fsIO';
import { pipelineLayout, VARIANTS, type Variant } from './variants';

/** Seeded ULIDs: the same variant gets the same IDs every time (mulberry32). */
export function seededIds(seed: number): IdFactory {
  let s = seed >>> 0;
  const prng = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const next = monotonicFactory(prng);
  const time = Date.parse('2026-10-20T08:00:00Z');
  return () => next(time) as Ulid;
}

export const debug = (msg: string): ImplBinding => ({
  kind: 'module',
  ref: 'ansible.builtin.debug',
  params: { msg },
});

export const assertThat = (that: string, failMsg: string): ImplBinding => ({
  kind: 'module',
  ref: 'ansible.builtin.assert',
  params: { that: [that], fail_msg: failMsg, quiet: true },
});

export async function must(what: string, p: Promise<{ text: string; isError?: boolean }>) {
  const r = await p;
  if (r.isError) throw new Error(`${what}: ${r.text}`);
  return r.text;
}

/** A new flow with its steps: flow_new, then one flow_edit batch. */
export async function build(io: FlowIO, path: string, name: string, goal: string, ops: Op[]) {
  await must(`${path} new`, flowNew(io, { path, name, goal }));
  await must(`${path} edit`, flowEdit(io, { path, ops }));
}

/** A chain of steps after `from`, each failed_hosts to `failTo`. */
export function chain(
  from: string,
  steps: { key: string; title: string; intent: string; impl?: ImplBinding }[],
  failTo: string | undefined,
  extra: (s: { key: string }) => Partial<Extract<Op, { op: 'add_node' }>> = () => ({}),
): Op[] {
  let after = from;
  return steps.map((s) => {
    const op: Op = {
      op: 'add_node',
      type: 'task',
      title: s.title,
      key: s.key,
      intent: s.intent,
      after,
      ...(failTo ? { failed_to: failTo } : {}),
      ...(s.impl ? { impl: s.impl } : {}),
      ...extra(s),
    };
    after = `${s.key}.ok_hosts`;
    return op;
  });
}

export const end = (key: string, title: string, outcome: 'success' | 'failed'): Op => ({
  op: 'add_node',
  type: 'end',
  key,
  title,
  outcome,
});

async function baseline(io: FlowIO, v: Variant) {
  const b = v.baseline;
  await build(io, `flows/network/${b.key}.flow.yaml`, b.name, b.goal, [
    end('stopped', 'Stopped', 'failed'),
    ...chain('start.ok_hosts', [{ ...b.check, impl: debug(b.check.msg) }], undefined),
    ...chain(`${b.check.key}.ok_hosts`, [b.draft], 'stopped'),
    ...chain(`${b.draft.key}.ok_hosts`, [{ ...b.save, impl: debug(b.save.msg) }], 'stopped'),
  ]);
}

export async function health(
  io: FlowIO,
  v: Pick<Variant, 'health' | 'hosts' | 'deviceWord'>,
  root: string,
  dir = 'flows/network',
) {
  const h = v.health;
  await build(io, `${dir}/${h.key}.flow.yaml`, h.name, h.goal, [
    end('reported', h.reported, 'failed'),
    end('stopped', 'Stopped', 'failed'),
    ...chain(
      'start.ok_hosts',
      [{ ...h.first, impl: assertThat(h.first.that, h.first.failMsg) }],
      'reported',
    ),
    ...chain(
      `${h.first.key}.ok_hosts`,
      [
        { ...h.second, impl: assertThat(h.second.that, h.second.failMsg) },
        { ...h.collect, impl: debug(h.collect.msg) },
      ],
      'stopped',
    ),
  ]);
  const one = v.hosts[0]?.name;
  // The host the scenario forces through the second check (lab-sw-04 in A, lab-rt-14 in B).
  const four = h.second.fails;
  const scenarios = [
    `# Scenario tests for ${h.name}: fictional hosts, local connection.`,
    `flow: ${h.key}`,
    'scenarios:',
    `  - name: every ${v.deviceWord} passes`,
    '    inputs:',
    `      devices: [${one}, ${v.hosts[1]?.name}]`,
    '    expect:',
    `      ${one}: done`,
    `      ${v.hosts[1]?.name}: done`,
    `  - name: ${h.scenarioName}`,
    '    inputs:',
    `      devices: [${one}, ${four}]`,
    '    force:',
    `      ${h.second.key}:`,
    `        failed: [${four}]`,
    '    expect:',
    `      ${one}: done`,
    `      ${four}: reported`,
    '',
  ].join('\n');
  await writeFile(join(root, dir, `${h.key}.scenarios.yaml`), scenarios);
}

async function rollout(io: FlowIO, v: Variant) {
  const r = v.rollout;
  const path = `flows/network/${r.key}.flow.yaml`;
  await must(`${path} new`, flowNew(io, { path, name: r.name, goal: r.goal }));
  const inputs = (names: string[]) =>
    Object.fromEntries(
      names.map((n) => [n, { type: r.inputs[n]?.type ?? 'string', from: `flow.${n}` }]),
    );
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
            field: { type: f.type, required: true },
          }),
        ),
        end('stopped', 'Stopped', 'failed'),
        ...r.steps.flatMap((s, i) =>
          chain(
            i === 0 ? 'start.ok_hosts' : `${r.steps[i - 1]?.key}.ok_hosts`,
            [{ ...s, impl: debug(s.msg) }],
            'stopped',
            () => ({ inputs: inputs(s.reads) }),
          ),
        ),
      ],
    }),
  );
}

export async function upgrade(io: FlowIO, v: Pick<Variant, 'upgrade'>, dir = 'flows/datacenter') {
  const u = v.upgrade;
  const path = `${dir}/${u.key}.flow.yaml`;
  const ops: Op[] = [
    end('cancelled', 'Cancelled', 'failed'),
    end('stopped', 'Stopped', 'failed'),
    {
      op: 'add_node',
      type: 'approval',
      key: 'approve-window',
      title: u.approval,
      intent: u.approvalIntent,
      after: 'start.ok_hosts',
    },
    { op: 'connect', from: 'approve-window.rejected', to: 'cancelled' },
  ];
  let after = 'approve-window.approved';
  for (const sub of u.subflows) {
    ops.push({
      op: 'add_node',
      type: 'subflow',
      key: sub.key,
      title: sub.title,
      intent: sub.intent,
      after,
      failed_to: 'stopped',
    });
    after = `${sub.key}.ok_hosts`;
    if (sub.key === u.midApproval.after) {
      ops.push({
        op: 'add_node',
        type: 'approval',
        key: u.midApproval.key,
        title: u.midApproval.title,
        intent: u.midApproval.intent,
        after,
      });
      ops.push({ op: 'connect', from: `${u.midApproval.key}.rejected`, to: 'cancelled' });
      after = `${u.midApproval.key}.approved`;
    }
    // The inner output the next inner step continues from.
    let inner: string | undefined;
    for (const s of sub.steps) {
      const at = `${sub.key}/${s.key}`;
      const place = inner ? { after: inner } : { in: sub.key };
      if (s.kind === 'decision') {
        ops.push({
          op: 'add_node',
          type: 'decision',
          key: s.key,
          title: s.title,
          intent: s.intent,
          condition: s.condition,
          ...place,
        });
        ops.push({ op: 'add_exit', from: `${at}.true`, port: 'ok_hosts' });
        ops.push({ op: 'add_exit', from: `${at}.false`, port: 'failed_hosts' });
        inner = undefined;
        continue;
      }
      const approval = s.kind === 'approval';
      ops.push({
        op: 'add_node',
        type: approval ? 'approval' : 'task',
        key: s.key,
        title: s.title,
        intent: s.intent,
        ...place,
        ...(s.msg ? { impl: debug(s.msg) } : {}),
        ...(s.become ? { settings: { become: true } } : {}),
      });
      if (!inner) ops.push({ op: 'set_entry', subflow: sub.key, node: s.key });
      ops.push({
        op: 'add_exit',
        from: `${at}.${approval ? 'rejected' : 'failed_hosts'}`,
        port: 'failed_hosts',
      });
      inner = `${at}.${approval ? 'approved' : 'ok_hosts'}`;
    }
    if (inner) ops.push({ op: 'add_exit', from: inner, port: 'ok_hosts' });
  }
  await build(io, path, u.name, u.goal, ops);
}

export async function pipeline(io: FlowIO, v: Pick<Variant, 'pipeline'>) {
  const p = v.pipeline;
  const path = `flows/platform/${p.key}.flow.yaml`;
  const ops: Op[] = [
    end('failed', 'Build failed', 'failed'),
    ...chain(
      'start.ok_hosts',
      p.steps.map((s) => ({ ...s, impl: debug(s.msg) })),
      'failed',
    ),
  ];
  // Hand-placed, as a careful author left it: the three build steps sit unevenly (T10).
  const nodes = pipelineLayout(p);
  ops.push({ op: 'move', nodes });
  ops.push({
    op: 'annotate',
    kind: 'section',
    text: p.section,
    position: { x: 220, y: 220 },
    width: 440,
    height: 420,
    color: 'blue',
  });
  await build(io, path, p.name, p.goal, ops);
}

export async function audit(io: FlowIO, v: Pick<Variant, 'audit'>, root: string) {
  const a = v.audit;
  const path = `flows/security/${a.key}.flow.yaml`;
  await build(io, path, a.name, a.goal, [
    end('stopped', 'Stopped', 'failed'),
    ...chain(
      'start.ok_hosts',
      a.steps.map((s) => ({ ...s, impl: debug(s.msg) })),
      'stopped',
    ),
  ]);
  // A hand edit gone wrong: one wire names a port that does not exist (an error; no code).
  const file = join(root, path);
  const text = readFileSync(file, 'utf8');
  const at = text.lastIndexOf('port: failed_hosts');
  writeFileSync(file, `${text.slice(0, at)}port: failed_host${text.slice(at + 18)}`);
}

async function rotation(io: FlowIO, v: Variant, root: string) {
  const r = v.rotation;
  const path = `flows/platform/${r.key}.flow.yaml`;
  await build(io, path, r.name, r.goal, [
    end('stopped', 'Stopped', 'failed'),
    ...chain(
      'start.ok_hosts',
      r.steps.map((s) => ({ ...s, impl: debug(s.msg) })),
      'stopped',
    ),
  ]);
  // Someone fixed the generated playbook by hand instead of the flow (T7).
  const file = join(root, 'flows/platform/generated', `${r.key}.yml`);
  const text = readFileSync(file, 'utf8');
  writeFileSync(file, text.replace(r.handEdit.from, r.handEdit.to));
}

/** T11: what a coding agent changes in the upgrade flow while the participant is away. */
export async function outsideEdit(
  io: FlowIO,
  v: Pick<Variant, 'outside' | 'upgrade'>,
  dir = 'flows/datacenter',
) {
  const o = v.outside;
  await must(
    'outside edit',
    flowEdit(io, {
      path: `${dir}/${v.upgrade.key}.flow.yaml`,
      ops: [
        {
          op: 'add_node',
          type: 'task',
          key: o.added.key,
          title: o.added.title,
          intent: o.added.intent,
          on_wire: o.added.after,
          impl: debug(o.added.msg),
        },
        {
          op: 'add_exit',
          from: `${o.added.sub}/${o.added.key}.failed_hosts`,
          port: 'failed_hosts',
        },
        { op: 'update_node', node: o.renamed.node, title: o.renamed.title },
        { op: 'bind', node: o.rebound.node, impl: debug(o.rebound.msg) },
      ],
    }),
  );
}

async function files(root: string, v: Variant) {
  await mkdir(join(root, 'inventory'), { recursive: true });
  await writeFile(
    join(root, 'ansible.cfg'),
    '[defaults]\ninventory = inventory/lab.ini\nhost_key_checking = False\nretry_files_enabled = False\n',
  );
  const lines = [
    `# Fictional lab ${v.deviceWord}s. Every host uses the local connection: nothing leaves the machine.`,
    '[lab]',
    ...v.hosts.map(
      (h) =>
        `${h.name} ${Object.entries(h.vars)
          .map(([k, x]) => `${k}=${x}`)
          .join(' ')}`,
    ),
    '',
    '[lab:vars]',
    'ansible_connection=local',
    'ansible_python_interpreter="{{ ansible_playbook_python }}"',
    '',
  ];
  await writeFile(join(root, 'inventory', 'lab.ini'), lines.join('\n'));
  await writeFile(
    join(root, 'README.md'),
    `# ${v.repo}\n\nA fictional automation repository for an Ansible Flow Designer usability session. The hosts in \`inventory/lab.ini\` use the local connection, so runs never reach a real device.\n`,
  );
}

const ioFor = (variant: 'a' | 'b', root: string) =>
  new FsFlowIO([root], createSchemaValidator(), seededIds(variant === 'a' ? 78 : 87));

/** Writes the workspace into `root` (an empty folder); returns one problems line per flow. */
export async function buildWorkspace(variant: 'a' | 'b', root: string): Promise<string[]> {
  const v = VARIANTS[variant];
  const io = ioFor(variant, root);
  await files(root, v);
  for (const dir of ['network', 'datacenter', 'platform', 'security'])
    await mkdir(join(root, 'flows', dir), { recursive: true });
  await baseline(io, v);
  await health(io, v, root);
  await rollout(io, v);
  await upgrade(io, v);
  await pipeline(io, v);
  await audit(io, v, root);
  await rotation(io, v, root);
  const lines: string[] = [];
  for (const path of await io.list())
    lines.push((await flowValidate(io, { path })).text.split('\n')[0] ?? path);
  return lines;
}

/** T11: the coding agent's edit, through the same tools an agent uses. */
export async function applyOutsideEdit(variant: 'a' | 'b', root: string): Promise<string> {
  const v = VARIANTS[variant];
  const io = new FsFlowIO([root], createSchemaValidator(), createIdFactory());
  await outsideEdit(io, v);
  return `flows/datacenter/${v.upgrade.key}.flow.yaml`;
}

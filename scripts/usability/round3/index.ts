// Round 3 (AFD-99): the test set of docs/ux/wave9-usability/tasks.md as a study the kit serves.
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { type FlowIO, flowEdit } from '../../../src/core/ai/handlers';
import type { Op } from '../../../src/core/ai/ops';
import { createIdFactory } from '../../../src/core/flow/ids';
import { createSchemaValidator } from '../../../src/core/flow/schema';
import type { FlowDocument } from '../../../src/core/flow/types';
import { FsFlowIO } from '../../../src/mcp/fsIO';
import type { Study } from '../study';
import { INTRO, PARTS, roundThreeCards } from './cards';
import { checkRound3 } from './check';
import { C } from './data';
import { buildRound3, colleagueChange } from './workspace';

const SECURITY = 'flows/security';
const PLATFORM = 'flows/platform';

/** Self-test: what a participant would leave behind for the file-checked tasks (T1-T9, T14, T15). */
async function solve(root: string): Promise<string> {
  const io: FlowIO = new FsFlowIO([root], createSchemaValidator(), createIdFactory());
  const edit = async (what: string, path: string, ops: Op[]) => {
    const r = await flowEdit(io, { path, ops });
    if (r.isError) throw new Error(`${what}: ${r.text}`);
  };
  const b = C.baseline;
  await edit('T1, T2', `${SECURITY}/${b.key}.flow.yaml`, [
    {
      op: 'add_node',
      type: 'task',
      key: 'check-mgmt',
      title: b.insert,
      on_wire: `${b.check.key}.ok_hosts`,
      failed_to: 'stopped',
    },
    {
      op: 'bind',
      node: b.banner.key,
      impl: { kind: 'module', ref: b.bind.module, params: b.bind.params },
    },
  ]);
  const d = C.deploy;
  const { backup: _, ...kept } = d.push.params;
  await edit('T3, T4, T6', `${SECURITY}/${d.key}.flow.yaml`, [
    {
      op: 'bind',
      node: d.push.key,
      impl: { kind: 'module', ref: d.push.module, params: { ...kept, mode: d.mode } },
    },
    {
      op: 'set_io',
      node: d.read.key,
      side: 'outputs',
      name: 'version',
      field: { type: 'string', from: 'impl.register.stdout' },
    },
    {
      op: 'set_io',
      node: d.report.key,
      side: 'inputs',
      name: 'version',
      field: { type: 'string', from: `${d.read.key}.version` },
    },
    {
      op: 'bind',
      node: d.report.key,
      impl: { kind: 'module', ref: d.report.module, params: { msg: 'Version: {{ version }}' } },
    },
    {
      op: 'update_node',
      node: d.wait.key,
      settings: {
        retries: d.retries,
        delay: d.delay,
        until: `'${d.until}' in wait_policy_result.stdout`,
      },
    },
  ]);
  const k = C.backup;
  await edit('T5, T8, T9', `${PLATFORM}/${k.key}.flow.yaml`, [
    {
      op: 'set_io',
      node: 'flow',
      side: 'inputs',
      name: 'archive_server',
      field: { type: 'string', required: true, description: k.description },
    },
    {
      op: 'set_io',
      node: k.upload.key,
      side: 'inputs',
      name: 'archive_server',
      field: { type: 'string', from: 'flow.archive_server' },
    },
    {
      op: 'bind',
      node: k.upload.key,
      impl: {
        kind: 'module',
        ref: k.upload.module,
        params: { url: 'https://{{ archive_server }}/upload', method: 'POST' },
      },
    },
    { op: 'update_node', node: k.readKey.key, settings: { become: true, become_user: k.user } },
    {
      op: 'bind',
      node: k.readKey.key,
      impl: {
        kind: 'module',
        ref: k.readKey.module,
        params: k.readKey.params,
        keywords: { no_log: true },
      },
    },
    {
      op: 'bind',
      node: k.exportZones.key,
      impl: {
        kind: 'module',
        ref: k.exportZones.module,
        params: { cmd: 'fwctl export --zone {{ item }}' },
        keywords: { loop: k.zones },
      },
    },
  ]);
  const u = C.upgrade;
  const upath = `${SECURITY}/${u.key}.flow.yaml`;
  const sub = (key: string) => u.subflows.find((x) => x.steps.some((y) => y.key === key))?.key;
  const doc = parse(readFileSync(join(root, upath), 'utf8')) as FlowDocument;
  const rootId = doc.nodes
    .find((n) => n.key === sub(u.needsRoot))
    ?.subflow?.nodes?.find((n) => n.key === u.needsRoot)?.id;
  await edit('T7, T15', upath, [
    { op: 'update_node', node: 'upgrade', settings: { rolling: 1 } },
    { op: 'update_node', node: `${sub(u.noRoot)}/${u.noRoot}`, settings: { become: null } },
    {
      op: 'accept',
      at: `${sub(u.needsRoot)}/${u.needsRoot}`,
      finding: `lens:access:become:${rootId}`,
      reason: 'Restarting the log daemon needs root on the firewall',
    },
  ]);
  // T14: the designer writes the playbook again only once the hand-edited one is out of the way,
  // as Generate Code's Overwrite does.
  const r = C.rotation;
  rmSync(join(root, PLATFORM, 'generated', `${r.key}.yml`));
  await edit('T14', `${PLATFORM}/${r.key}.flow.yaml`, [
    {
      op: 'bind',
      node: r.find.key,
      impl: { kind: 'module', ref: r.find.module, params: { ...r.find.params, age: r.age } },
    },
  ]);
  return 'Solved T1-T9, T14 and T15 in the workspace';
}

export function roundThreeStudy(): Study {
  return {
    cards: roundThreeCards(),
    parts: PARTS,
    intro: INTRO,
    build: buildRound3,
    outside: colleagueChange,
    verify: checkRound3,
    solve,
  };
}

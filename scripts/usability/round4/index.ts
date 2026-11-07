// Round 4 (AFD-109): the test set of docs/ux/wave10-usability/tasks.md as a study the kit serves.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { type FlowIO, flowEdit } from '../../../src/core/ai/handlers';
import type { Op } from '../../../src/core/ai/ops';
import { registerName } from '../../../src/core/flow/dataNames';
import { createIdFactory } from '../../../src/core/flow/ids';
import { createSchemaValidator } from '../../../src/core/flow/schema';
import type { FlowDocument } from '../../../src/core/flow/types';
import { FsFlowIO } from '../../../src/mcp/fsIO';
import type { Study } from '../study';
import { INTRO, PARTS, roundFourCards } from './cards';
import { checkRound4 } from './check';
import { D } from './data';
import { buildRound4, colleagueChange, EDGE } from './workspace';

/** Self-test: what a participant would leave behind for the file-checked tasks (D2-D6, D9). */
async function solve(root: string): Promise<string> {
  const io: FlowIO = new FsFlowIO([root], createSchemaValidator(), createIdFactory());
  const edit = async (what: string, path: string, ops: Op[]) => {
    const r = await flowEdit(io, { path, ops });
    if (r.isError) throw new Error(`${what}: ${r.text}`);
  };
  const p = D.pool;
  const waitResult = registerName({ key: p.wait.key } as never);
  const state = registerName({ key: p.readState.key } as never);
  await edit('D2-D6', `${EDGE}/${p.key}.flow.yaml`, [
    {
      op: 'update_node',
      node: p.wait.key,
      settings: {
        retries: p.retries,
        delay: p.delay,
        until: `'${p.until}' in ${waitResult}.stdout`,
      },
    },
    {
      op: 'bind',
      node: p.readKey.key,
      impl: {
        kind: 'module',
        ref: p.readKey.module,
        params: p.readKey.params,
        keywords: { no_log: true },
      },
    },
    {
      op: 'bind',
      node: p.disable.key,
      impl: {
        kind: 'module',
        ref: p.disable.module,
        params: { cmd: 'lbctl member disable {{ item }}' },
        keywords: { loop: p.members },
      },
    },
    // D5 as the @ list does it (0.68.0, 0.68.1): the result becomes an output there and an input
    // here, and the message reads its stdout field.
    {
      op: 'set_io',
      node: p.readState.key,
      side: 'outputs',
      name: state,
      field: { type: 'dict', from: 'impl.register' },
    },
    {
      op: 'set_io',
      node: p.report.key,
      side: 'inputs',
      name: state,
      field: { type: 'dict', from: `${p.readState.key}.${state}` },
    },
    {
      op: 'bind',
      node: p.report.key,
      impl: {
        kind: 'module',
        ref: p.report.module,
        params: { msg: `Pool state: {{ ${state}.stdout }}` },
      },
    },
    {
      op: 'set_io',
      node: 'flow',
      side: 'inputs',
      name: 'drain_wait',
      field: {
        type: 'integer',
        default: p.drainWait,
        description: 'Seconds to wait for the pool to drain',
      },
    },
  ]);
  const u = D.upgrade;
  const upath = `${EDGE}/${u.key}.flow.yaml`;
  const sub = (key: string) => u.subflows.find((x) => x.steps.some((y) => y.key === key))?.key;
  const doc = parse(readFileSync(join(root, upath), 'utf8')) as FlowDocument;
  const rootId = doc.nodes
    .find((n) => n.key === sub(u.needsRoot))
    ?.subflow?.nodes?.find((n) => n.key === u.needsRoot)?.id;
  await edit('D9', upath, [
    { op: 'update_node', node: `${sub(u.noRoot)}/${u.noRoot}`, settings: { become: null } },
    {
      op: 'accept',
      at: `${sub(u.needsRoot)}/${u.needsRoot}`,
      finding: `lens:access:become:${rootId}`,
      reason: 'The health daemon runs as root on the balancer',
    },
  ]);
  return 'Solved D2-D6 and D9 in the workspace';
}

export function roundFourStudy(): Study {
  return {
    cards: roundFourCards(),
    parts: PARTS,
    intro: INTRO,
    build: buildRound4,
    outside: colleagueChange,
    verify: checkRound4,
    solve,
  };
}

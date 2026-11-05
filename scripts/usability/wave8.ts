// Rounds 1 and 2 (AFD-78): the wave 8 test set with variant A or B's names.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import { type FlowIO, flowEdit, flowNew } from '../../src/core/ai/handlers';
import { createIdFactory } from '../../src/core/flow/ids';
import { createSchemaValidator } from '../../src/core/flow/schema';
import type { FlowDocument } from '../../src/core/flow/types';
import { FsFlowIO } from '../../src/mcp/fsIO';
import type { Study } from './study';
import { taskCards } from './tasks';
import { pipelineLayout, VARIANTS, type Variant } from './variants';
import { verify } from './verify';
import { applyOutsideEdit, buildWorkspace } from './workspace';

async function solve(v: Variant, root: string): Promise<string> {
  const io: FlowIO = new FsFlowIO([root], createSchemaValidator(), createIdFactory());
  const run = async (what: string, r: Promise<{ text: string; isError?: boolean }>) => {
    const x = await r;
    if (x.isError) throw new Error(`${what}: ${x.text}`);
  };
  const path = 'flows/first.flow.yaml';
  await run('T1', flowNew(io, { path, name: v.first.name }));
  await run(
    'T1',
    flowEdit(io, {
      path,
      ops: [
        {
          op: 'add_node',
          type: 'task',
          key: 'one',
          title: v.first.steps[0],
          after: 'start.ok_hosts',
        },
        {
          op: 'add_node',
          type: 'task',
          key: 'two',
          title: v.first.steps[1],
          after: 'one.ok_hosts',
        },
      ],
    }),
  );
  const b = v.baseline;
  await run(
    'T2-T3',
    flowEdit(io, {
      path: `flows/network/${b.key}.flow.yaml`,
      ops: [
        {
          op: 'bind',
          node: b.draft.key,
          impl: { kind: 'module', ref: b.bind.module, params: b.bind.params },
        },
        { op: 'connect', from: `${b.check.key}.failed_hosts`, to: 'stopped' },
      ],
    }),
  );
  const u = v.upgrade;
  const sub = (key: string) => u.subflows.find((x) => x.steps.some((y) => y.key === key))?.key;
  const upath = `flows/datacenter/${u.key}.flow.yaml`;
  const doc = parse(readFileSync(join(root, upath), 'utf8')) as FlowDocument;
  const rootId = doc.nodes
    .find((n) => n.key === sub(u.needsRoot))
    ?.subflow?.nodes?.find((n) => n.key === u.needsRoot)?.id;
  await run(
    'T9',
    flowEdit(io, {
      path: upath,
      ops: [
        { op: 'update_node', node: `${sub(u.noRoot)}/${u.noRoot}`, settings: { become: null } },
        {
          op: 'accept',
          at: `${sub(u.needsRoot)}/${u.needsRoot}`,
          finding: `lens:access:become:${rootId}`,
          reason: `Restarting the service needs root on the ${v.deviceWord}`,
        },
      ],
    }),
  );
  const lay = pipelineLayout(v.pipeline);
  const [l, t, k] = v.pipeline.steps.slice(1, 4).map((x) => x.key) as [string, string, string];
  await run(
    'T10',
    flowEdit(io, {
      path: `flows/platform/${v.pipeline.key}.flow.yaml`,
      ops: [
        {
          op: 'move',
          nodes: {
            [l]: { x: 320, y: lay[l]?.y ?? 0 },
            [t]: { x: 320, y: 400 },
            [k]: { x: 320, y: 2 * 400 - (lay[l]?.y ?? 0) },
          },
        },
      ],
    }),
  );
  return 'Solved T1, T2, T3, T9 and T10 in the workspace';
}

export function wave8Study(variant: 'a' | 'b'): Study {
  const v = VARIANTS[variant];
  return {
    cards: taskCards(v),
    parts: {
      1: { title: 'build and run', note: 'VS Code is open on the lab repository.' },
      2: {
        title: 'find and review',
        note: 'Take a short break first if you like: the clock only runs inside a task.',
      },
    },
    intro: 'in two parts with a break between them. It takes about an hour.',
    build: (root) => buildWorkspace(variant, root),
    outside: async ({ workspace }) => {
      const file = await applyOutsideEdit(variant, workspace);
      return { file, message: `The agent has changed ${file}. Look at it in VS Code now.` };
    },
    verify: ({ workspace, storage }, answers) => verify(v, workspace, storage, answers),
    solve: (root) => solve(v, root),
  };
}

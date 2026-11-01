// AFD-53: a step's outputs other than its register land in its own variable right after it runs,
// so two steps setting the same fact no longer overwrite what readers get.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { optionA } from '../../../src/core/engine/optionA';
import { type FlowCommand, planCommand } from '../../../src/core/flow/commands';
import { completeIds } from '../../../src/core/flow/completeIds';
import { outputVar } from '../../../src/core/flow/dataNames';
import { createIdFactory } from '../../../src/core/flow/ids';
import { buildModel } from '../../../src/core/flow/model';
import type { FlowDocument } from '../../../src/core/flow/types';

const ctx = { newId: createIdFactory() };
const SAME = completeIds(
  readFileSync(join(__dirname, '../../fixtures/engine/same-fact.flow.yaml'), 'utf8'),
  ctx.newId,
).text;
const doc = (text: string) => parse(text) as FlowDocument;
const entry = (text: string, key: string) =>
  [...buildModel(doc(text)).nodes.values()].find((e) => e.node.key === key);
const id = (text: string, key: string) => entry(text, key)?.node.id as string;
const run = (text: string, cmd: FlowCommand) => planCommand(text, cmd, ctx).text;
type Play = { name: string; vars?: Record<string, string>; tasks?: Record<string, unknown>[] };
const plays = (text: string, file = 0) =>
  parse(optionA.generate(doc(text), { source: 'x' }).files[file]?.text ?? '') as Play[];
const play = (all: Play[], key: string) => all.find((p) => p.name?.startsWith(`[${key}]`));
const varOf = (text: string, key: string, out: string) => {
  const e = entry(text, key);
  if (!e) throw new Error(key);
  return outputVar(buildModel(doc(text)), e.node, out);
};

describe('outputs captured per step (AFD-53)', () => {
  it('two steps setting the same fact: each is kept in its own variable, and readers get both', () => {
    const all = plays(SAME);
    const block = (key: string) => (play(all, key)?.tasks?.[0]?.block ?? []) as unknown[];
    expect(block('running')).toContainEqual({
      name: '[running] keep output version',
      'ansible.builtin.set_fact': { afd_running__version: '{{ version }}' },
      when: 'version is defined',
    });
    expect(block('target')).toContainEqual(
      expect.objectContaining({
        'ansible.builtin.set_fact': { afd_target__version: '{{ version }}' },
      }),
    );
    expect(play(all, 'compare')?.vars).toMatchObject({
      running: '{{ afd_running__version }}',
      target: '{{ afd_target__version }}',
    });
  });

  it('a step moved into a subflow keeps the name; a key used on two levels gets the path', () => {
    const inside = run(SAME, {
      kind: 'extractSubflow',
      nodes: [id(SAME, 'target')],
      title: 'Read target',
    });
    expect(varOf(inside, 'target', 'version')).toBe('afd_target__version');
    expect(varOf(inside, 'read-target', 'version')).toBe('afd_target__version');
    // A second `running`, inside the subflow: both are named by where they are.
    const added = planCommand(
      inside,
      {
        kind: 'addNode',
        parent: id(inside, 'read-target'),
        type: 'task',
        title: 'Running',
        key: 'running',
      },
      ctx,
    );
    const twice = run(added.text, {
      kind: 'setContractField',
      target: added.created as string,
      side: 'outputs',
      name: 'version',
      field: { type: 'string' },
    });
    const ids = [...buildModel(doc(twice)).nodes.values()].filter((e) => e.node.key === 'running');
    expect(ids.map((e) => outputVar(buildModel(doc(twice)), e.node, 'version')).sort()).toEqual([
      'afd_read_target__running__version',
      'afd_running__version',
    ]);
  });

  it('a register stays the register; a playbook step keeps its outputs in its route play', () => {
    const registered = run(SAME, {
      kind: 'setBinding',
      id: id(SAME, 'running'),
      impl: { kind: 'module', ref: 'ansible.builtin.command', params: { cmd: 'show version' } },
      outputs: { version: { type: 'string', from: 'impl.register.stdout' } },
    });
    expect(varOf(registered, 'running', 'version')).toBe('running_result.stdout');
    const block = (play(plays(registered), 'running')?.tasks?.[0]?.block ?? []) as {
      name?: string;
    }[];
    expect(block.map((t) => t.name)).not.toContain('[running] keep output version');

    const book = run(SAME, {
      kind: 'setBinding',
      id: id(SAME, 'running'),
      impl: { kind: 'playbook', ref: 'playbooks/version.yml' },
    });
    const route = play(plays(book), 'running');
    expect(route?.name).toContain(': route');
    expect(route?.tasks?.[0]).toMatchObject({
      'ansible.builtin.set_fact': { afd_running__version: '{{ version }}' },
    });
  });
});

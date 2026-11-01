// AFD-52 part 1: privilege in format 2. become and become_user set on a subflow reach the steps
// inside (the nearest setting wins, a step can say no); the generated plays carry them; format 1
// generates what it always did; the upgrade moves become_user out of the task keywords and says
// which subflows now pass become on.
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { optionA } from '../../../src/core/engine/optionA';
import { type FlowCommand, planCommand } from '../../../src/core/flow/commands';
import { createIdFactory } from '../../../src/core/flow/ids';
import { privilegeOf } from '../../../src/core/flow/inherit';
import { upgradeNotes } from '../../../src/core/flow/migrate';
import { buildModel } from '../../../src/core/flow/model';
import type { FlowDocument } from '../../../src/core/flow/types';
import { validateFlow } from '../../../src/core/flow/validate';
import { readExample } from './helpers';

const ctx = { newId: createIdFactory() };
const V1 = readExample('os-upgrade.flow.yaml');
const V2 = planCommand(V1, { kind: 'upgradeFormat' }, ctx).text;
const run = (text: string, cmd: FlowCommand) => planCommand(text, cmd, ctx).text;
const doc = (text: string) => parse(text) as FlowDocument;
const entry = (text: string, key: string) =>
  [...buildModel(doc(text)).nodes.values()].find((e) => e.node.key === key) as NonNullable<
    ReturnType<ReturnType<typeof buildModel>['nodes']['get']>
  >;
const setOn = (text: string, key: string, settings: Record<string, unknown>) =>
  run(text, { kind: 'updateNode', id: entry(text, key).node.id, patch: { settings } });

/** The play the engine writes for a node, by its title line. */
const playOf = (text: string, key: string) => {
  const result = optionA.generate(doc(text), { source: 'os-upgrade.flow.yaml' });
  for (const f of result.files)
    for (const play of (parse(f.text) as Record<string, unknown>[]) ?? [])
      if (typeof play?.name === 'string' && play.name.startsWith(`[${key}]`)) return play;
  throw new Error(`no play for ${key}`);
};

describe('format 2: privilege from the subflows around a step', () => {
  const withBecome = setOn(V2, 'upgrade-os', { become: true, become_user: 'netops' });

  it('a step inside inherits become and whom; a step may say no; format 1 does not inherit', () => {
    const model = buildModel(doc(withBecome));
    const inner = entry(withBecome, 'reload');
    expect(privilegeOf(model, inner.node)).toEqual({
      become: true,
      become_user: 'netops',
      from: entry(withBecome, 'upgrade-os').node.id,
    });
    const opted = setOn(withBecome, 'reload', { become: false });
    expect(privilegeOf(buildModel(doc(opted)), entry(opted, 'reload').node)).toEqual({});
    const v1 = setOn(V1, 'upgrade-os', { become: true });
    expect(privilegeOf(buildModel(doc(v1)), entry(v1, 'reload').node)).toEqual({});
  });

  it('the generated plays of the steps inside run with it; format 1 plays do not', () => {
    expect(playOf(withBecome, 'reload')).toMatchObject({ become: true, become_user: 'netops' });
    expect(playOf(V2, 'reload')).not.toHaveProperty('become');
    const v1 = setOn(V1, 'upgrade-os', { become: true });
    expect(playOf(v1, 'reload')).not.toHaveProperty('become');
  });
});

describe('the upgrade', () => {
  it('moves become_user out of the task keywords, and says where become now reaches', () => {
    const reload = entry(V1, 'reload').node;
    const keyworded = run(V1, {
      kind: 'setBinding',
      id: reload.id,
      impl: {
        ...(reload.impl ?? { kind: 'module', ref: 'ansible.builtin.reboot' }),
        keywords: { become_user: 'netops' },
      },
    });
    const withBecome = setOn(keyworded, 'upgrade-os', { become: true });
    const notes = upgradeNotes(doc(withBecome));
    expect(notes).toContain(
      'become_user moves from task keywords to the Privilege settings (1 node)',
    );
    expect(notes.some((n) => /^become on .+ now applies to its \d+ steps?$/.test(n))).toBe(true);
    const up = run(withBecome, { kind: 'upgradeFormat' });
    const moved = entry(up, 'reload').node;
    expect(moved.settings?.become_user).toBe('netops');
    expect(moved.impl?.keywords).toBeUndefined();
    expect(validateFlow(doc(up)).findings.map((f) => f.code)).not.toContain('keyword-is-setting');
  });

  it('format 2 warns about become_user written as a keyword', () => {
    const reload = entry(V2, 'reload').node;
    const keyworded = run(V2, {
      kind: 'setBinding',
      id: reload.id,
      impl: {
        ...(reload.impl ?? { kind: 'module', ref: 'ansible.builtin.reboot' }),
        keywords: { become_user: 'x' },
      },
    });
    expect(validateFlow(doc(keyworded)).findings.map((f) => f.code)).toContain(
      'keyword-is-setting',
    );
  });
});

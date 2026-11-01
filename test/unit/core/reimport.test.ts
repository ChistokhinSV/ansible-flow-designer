// AFD-61: a flow imported from a playbook takes the playbook's later changes without losing the
// designer's: the source's version where only the source changed, a conflict where both did, new
// tasks after the task before them, steps whose task is gone flagged.
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { type FlowCommand, planCommand } from '../../../src/core/flow/commands';
import { createIdFactory } from '../../../src/core/flow/ids';
import { buildModel } from '../../../src/core/flow/model';
import { createSchemaValidator } from '../../../src/core/flow/schema';
import { flowText } from '../../../src/core/flow/text';
import type { FlowDocument, FlowNode } from '../../../src/core/flow/types';
import { validateFlow } from '../../../src/core/flow/validate';
import { importPlaybook } from '../../../src/core/import/playbook';
import type { SourceIO } from '../../../src/core/import/read';
import { planReimport, stepDesign } from '../../../src/core/import/reimport';
import { readPlaybook } from '../../../src/core/import/source';

const schema = createSchemaValidator();
const ctx = { newId: createIdFactory() };

const PLAYBOOK = `- name: Edge baseline
  hosts: edge
  gather_facts: false
  tasks:
    - name: Check reachability
      ansible.builtin.ping:
    - name: Push NTP
      ansible.builtin.debug:
        msg: ntp
    - name: Push AAA
      ansible.builtin.debug:
        msg: aaa
    - name: Save config
      ansible.builtin.debug:
        msg: save
`;

async function imported(text: string): Promise<string> {
  const io: SourceIO = { read: async () => text, list: async () => [] };
  const read = await readPlaybook(io, 'site.yml');
  if (!read.playbook) throw new Error(read.notes.join('\n'));
  const r = importPlaybook(read.playbook, {
    key: 'edge',
    newId: createIdFactory(),
    generatedDir: 'flows/edge/generated',
  });
  return flowText(r.doc);
}
const doc = (text: string) => parse(text) as FlowDocument;
const step = (text: string, title: string) =>
  [...buildModel(doc(text)).nodes.values()].find((e) => e.node.title === title)?.node as FlowNode;
const run = (text: string, cmd: FlowCommand) => planCommand(text, cmd, ctx).text;

describe('re-import from source (AFD-61)', () => {
  it('each imported step records its task and how it looked', async () => {
    const text = await imported(PLAYBOOK);
    const ntp = step(text, 'Push NTP');
    expect(ntp.origin).toEqual({ task: 'site.yml#Push NTP#1', design: stepDesign(ntp) });
    expect(schema(doc(text))).toEqual([]);
  });

  it('merges: source-only changes apply, both-changed conflict, new tasks follow, gone ones are flagged', async () => {
    let mine = await imported(PLAYBOOK);
    // The designer changes Push AAA and Save config.
    mine = run(mine, {
      kind: 'updateNode',
      id: step(mine, 'Push AAA').id,
      patch: { intent: 'AAA with TACACS' },
    });
    mine = run(mine, {
      kind: 'updateNode',
      id: step(mine, 'Save config').id,
      patch: { title: 'Save running config' },
    });
    // The playbook changes NTP (only the source) and Save (both), adds a task, drops AAA.
    const changed = PLAYBOOK.replace('msg: ntp', 'msg: ntp v2')
      .replace('msg: save', 'msg: save v2')
      .replace(
        '    - name: Save config',
        '    - name: Push syslog\n      ansible.builtin.debug:\n        msg: syslog\n    - name: Save config',
      )
      .replace('    - name: Push AAA\n      ansible.builtin.debug:\n        msg: aaa\n', '');
    const fresh = doc(await imported(changed));
    const plan = planReimport(doc(mine), fresh);
    expect(plan.updates.map((u) => [u.key, u.changed])).toEqual([['push-ntp', ['impl']]]);
    expect(plan.conflicts.map((u) => u.key)).toEqual(['save-config']);
    expect(plan.adds.map((a) => [a.step.title, a.after])).toEqual([
      ['Push syslog', step(mine, 'Push NTP').id],
    ]);
    expect(plan.gone.map((g) => g.key)).toEqual(['push-aaa']);
    expect(plan.same).toBe(1); // Check reachability

    // Applied without the conflict: NTP takes the source, Save keeps the designer's version and
    // notes the source's, so the conflict is not offered again.
    const merged = run(mine, {
      kind: 'reimport',
      updates: plan.updates,
      adds: plan.adds,
      gone: plan.gone.map((g) => g.node),
      keep: plan.conflicts.map((c) => ({ node: c.node, design: c.design })),
    });
    const settled = planReimport(doc(merged), fresh);
    expect(
      [settled.updates, settled.conflicts, settled.adds, settled.gone].map((l) => l.length),
    ).toEqual([0, 0, 0, 0]);
    expect(step(merged, 'Push NTP').impl?.params).toEqual({ msg: 'ntp v2' });
    expect(step(merged, 'Save running config').impl?.params).toEqual({ msg: 'save' });
    const syslog = step(merged, 'Push syslog');
    expect(syslog.origin?.task).toBe('site.yml#Push syslog#1');
    const wires = doc(merged).edges.map((e) => [e.from.node, e.to.node]);
    expect(wires).toContainEqual([step(merged, 'Push NTP').id, syslog.id]);
    expect(step(merged, 'Push AAA').origin?.gone).toBe(true);
    expect(validateFlow(doc(merged)).findings.map((f) => f.code)).toContain('import-gone');
    expect(schema(doc(merged))).toEqual([]);

    // Taking the source on the conflict too; a second re-import has nothing left to do.
    const all = run(mine, {
      kind: 'reimport',
      updates: [...plan.updates, ...plan.conflicts],
      adds: plan.adds,
      gone: plan.gone.map((g) => g.node),
    });
    expect(step(all, 'Save config').impl?.params).toEqual({ msg: 'save v2' });
    const again = planReimport(doc(all), fresh);
    expect([again.updates, again.conflicts, again.adds, again.gone].map((l) => l.length)).toEqual([
      0, 0, 0, 0,
    ]);
  });
});

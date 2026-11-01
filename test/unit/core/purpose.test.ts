// AFD-52 part 3: `handler` reads like an Ansible handler, which the node is not; format 2 calls it
// `purpose`. Writers use the format's name, readers take either, the upgrade renames it in place.
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { applyOps } from '../../../src/core/ai/ops';
import { type FlowCommand, planCommand } from '../../../src/core/flow/commands';
import { purposeOf } from '../../../src/core/flow/format';
import { createIdFactory } from '../../../src/core/flow/ids';
import { upgradeNotes } from '../../../src/core/flow/migrate';
import type { FlowDocument } from '../../../src/core/flow/types';
import { validateFlow } from '../../../src/core/flow/validate';
import { readExample } from './helpers';

const ctx = { newId: createIdFactory() };
const V1 = readExample('edge-baseline.flow.yaml');
const V2 = planCommand(V1, { kind: 'upgradeFormat' }, ctx).text;
const plan = (text: string, cmd: FlowCommand) => planCommand(text, cmd, ctx);
const doc = (text: string) => parse(text) as FlowDocument;
const id = (text: string, key: string) => doc(text).nodes.find((n) => n.key === key)?.id as string;
const notifyOn = (text: string) =>
  plan(text, {
    kind: 'applyPattern',
    pattern: 'notify-stop',
    from: { node: id(text, 'precheck'), port: 'failed_hosts' },
  });

describe('purpose (format 2) and handler (format 1)', () => {
  it('a pattern writes the format’s name; readers take either', () => {
    const one = notifyOn(V1);
    const two = notifyOn(V2);
    const n1 = doc(one.text).nodes.find((n) => n.id === one.created);
    const n2 = doc(two.text).nodes.find((n) => n.id === two.created);
    expect(n1).toMatchObject({ handler: 'notify' });
    expect(n1?.purpose).toBeUndefined();
    expect(n2).toMatchObject({ purpose: 'notify' });
    expect(n2?.handler).toBeUndefined();
    expect([purposeOf(n1), purposeOf(n2)]).toEqual(['notify', 'notify']);
  });

  it('the upgrade renames handler in place and says so; format 2 warns about one left', () => {
    const r = notifyOn(V1);
    const notes = upgradeNotes(doc(r.text));
    expect(notes).toContain('handler is called purpose (1 node)');
    const up = plan(r.text, { kind: 'upgradeFormat' }).text;
    expect(up).toContain('  purpose: notify\n');
    expect(up).not.toContain('handler:');
    const stray = up.replace('  purpose: notify\n', '  handler: notify\n');
    const codes = validateFlow(doc(stray)).findings.map((f) => f.code);
    expect(codes).toContain('renamed-field');
    expect(validateFlow(doc(up)).findings.map((f) => f.code)).not.toContain('renamed-field');
  });

  it('an edit in format 2 writes purpose and drops a handler left over', () => {
    const r = notifyOn(V2);
    const stray = r.text.replace('  purpose: notify\n', '  handler: notify\n');
    const fixed = plan(stray, {
      kind: 'updateNode',
      id: r.created as string,
      patch: { purpose: 'rollback' },
    }).text;
    const n = doc(fixed).nodes.find((x) => x.id === r.created);
    expect(n).toMatchObject({ purpose: 'rollback' });
    expect(n?.handler).toBeUndefined();
  });

  it('the AI update_node still takes handler, as purpose', async () => {
    const r = notifyOn(V2);
    const out = await applyOps(
      r.text,
      [{ op: 'update_node', node: 'notify-on-call', handler: 'retry' }],
      {
        newId: ctx.newId,
      },
    );
    expect(doc(out.text).nodes.find((n) => n.id === r.created)).toMatchObject({
      purpose: 'retry',
    });
  });
});

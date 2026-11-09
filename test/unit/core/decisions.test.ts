// AFD-51: one kind of decision in format 2. Ports, drift items, lens findings and problems are each
// an `accepted` record keyed by what it accepts; every reader sees both formats alike; a warning
// can be accepted (format 2), and the upgrade converts the three old kinds.
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { applyOps } from '../../../src/core/ai/ops';
import { openOnPurpose } from '../../../src/core/flow/bubbling';
import { copyNodes } from '../../../src/core/flow/clipboard';
import { CommandError, type FlowCommand, planCommand } from '../../../src/core/flow/commands';
import { acceptedAll, acceptedOf, checkWhat, findingOf } from '../../../src/core/flow/decisions';
import { createIdFactory } from '../../../src/core/flow/ids';
import { buildModel } from '../../../src/core/flow/model';
import type { Decision, FlowDocument } from '../../../src/core/flow/types';
import { validateFlow } from '../../../src/core/flow/validate';
import { readExample } from './helpers';

const ctx = { newId: createIdFactory() };
const V1 = readExample('edge-baseline.flow.yaml');
const V2 = planCommand(V1, { kind: 'upgradeFormat' }, ctx).text;
const run = (text: string, cmd: FlowCommand) => planCommand(text, cmd, ctx).text;
const doc = (text: string) => parse(text) as FlowDocument;
const id = (key: string) => doc(V2).nodes.find((n) => n.key === key)?.id as string;
const decisions = (text: string) => doc(text).decisions ?? [];

describe('one view over both formats', () => {
  it('reads the three format 1 kinds and the format 2 one as what they accept', () => {
    const v1: Decision[] = [
      { kind: 'open_on_purpose', node: 'N1', port: 'failed_hosts', reason: 'a' },
      { kind: 'drift_ignored', node: 'N1', item: 'task-order', reason: 'b' },
      { kind: 'finding_accepted', finding: 'access:become|N1', reason: 'c' },
      { kind: 'accepted', node: 'N1', finding: 'check:binding-unknown-var:x', reason: 'd' },
    ];
    expect(v1.map((d, i) => acceptedOf(d, i)).map((a) => [a?.area, a?.what])).toEqual([
      ['port', 'failed_hosts'],
      ['drift', 'task-order'],
      ['lens', 'access:become|N1'],
      ['check', 'binding-unknown-var:x'],
    ]);
    expect(findingOf('check', checkWhat('binding-unknown-var', 'x'))).toBe(
      'check:binding-unknown-var:x',
    );
  });

  it('the upgrade turns every old decision into an accepted one; readers see the same', () => {
    const was = doc(V1);
    const now = doc(V2);
    expect(decisions(V1).every((d) => d.kind !== 'accepted')).toBe(true);
    expect(decisions(V2).every((d) => d.kind === 'accepted')).toBe(true);
    expect(openOnPurpose(now)).toEqual(openOnPurpose(was));
    const view = (d: FlowDocument) => acceptedAll(d).map(({ index: _i, ...a }) => a);
    expect(view(now)).toEqual(view(was));
  });
});

describe('format 2 writers', () => {
  it('a port left open, a drift item and a lens finding are accepted records', () => {
    const open = run(V2, {
      kind: 'setDecision',
      node: id('validate'),
      port: 'failed_hosts',
      reason: 'Reported, not rolled back',
      by: 'Pat',
    });
    const drift = run(open, {
      kind: 'ignoreDrift',
      node: id('validate'),
      item: 'extra-task',
      reason: 'Kept on purpose',
    });
    const lens = run(drift, {
      kind: 'acceptFinding',
      finding: `inventory:broad-target:${id('validate')}`,
      node: id('validate'),
      reason: 'All edge switches',
    });
    expect(decisions(lens).slice(-3)).toEqual([
      {
        kind: 'accepted',
        node: id('validate'),
        finding: 'port:failed_hosts',
        reason: 'Reported, not rolled back',
        by: 'Pat',
      },
      {
        kind: 'accepted',
        node: id('validate'),
        finding: 'drift:extra-task',
        reason: 'Kept on purpose',
      },
      {
        kind: 'accepted',
        node: id('validate'),
        finding: `lens:inventory:broad-target:${id('validate')}`,
        reason: 'All edge switches',
      },
    ]);
    const cleared = run(
      run(run(lens, { kind: 'clearDecision', node: id('validate'), port: 'failed_hosts' }), {
        kind: 'clearDriftIgnore',
        node: id('validate'),
        item: 'extra-task',
      }),
      { kind: 'clearFindingAccept', finding: `inventory:broad-target:${id('validate')}` },
    );
    expect(decisions(cleared)).toEqual(decisions(V2));
  });

  it('a warning accepted with a reason stops showing for that node and subject only', () => {
    const reads = run(V2, {
      kind: 'setBinding',
      id: id('precheck'),
      impl: {
        kind: 'module',
        ref: 'ansible.builtin.debug',
        params: { msg: '{{ ntp_servers }} {{ syslog_host }}' },
      },
    });
    const unknown = (text: string) =>
      validateFlow(doc(text))
        .findings.filter((f) => f.code === 'binding-unknown-var' && f.node === id('precheck'))
        .map((f) => f.subject);
    expect(unknown(reads).sort()).toEqual(['ntp_servers', 'syslog_host']);
    const accepted = run(reads, {
      kind: 'acceptCheck',
      node: id('precheck'),
      code: 'binding-unknown-var',
      subject: 'ntp_servers',
      reason: 'Set in group_vars/edge.yml',
    });
    expect(unknown(accepted)).toEqual(['syslog_host']);
    const back = run(accepted, {
      kind: 'clearCheckAccept',
      node: id('precheck'),
      code: 'binding-unknown-var',
      subject: 'ntp_servers',
    });
    expect(unknown(back).sort()).toEqual(['ntp_servers', 'syslog_host']);
  });

  it('format 1 explains the upgrade instead of accepting a problem', () => {
    let err: unknown;
    try {
      planCommand(
        V1,
        {
          kind: 'acceptCheck',
          node: id('precheck'),
          code: 'binding-unknown-var',
          subject: 'x',
          reason: 'r',
        },
        ctx,
      );
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(CommandError);
    expect((err as CommandError).code).toBe('needs-format');
    expect((err as Error).message).toMatch(/Upgrade Flow Format/);
  });

  it('ports pasted from a format 1 flow are written in format 2', () => {
    // The example's one decision: a port of this node is open on purpose.
    const open = decisions(V1)[0]?.node as string;
    const text = copyNodes(doc(V1), [open]);
    const pasted = planCommand(V2, { kind: 'pasteNodes', text, level: 'root' }, ctx);
    const fresh = pasted.pasted?.[0] as string;
    expect(decisions(pasted.text).at(-1)).toMatchObject({
      kind: 'accepted',
      node: fresh,
      finding: 'port:failed_hosts',
    });
  });
});

describe('the AI tools', () => {
  it('accept and unaccept cover ports and problems; leave_open still works', async () => {
    const opts = { newId: createIdFactory() };
    const port = await applyOps(
      V2,
      [{ op: 'accept', at: 'validate.failed_hosts', reason: 'Reported, not rolled back' }],
      opts,
    );
    expect(decisions(port.text).at(-1)).toMatchObject({ finding: 'port:failed_hosts' });
    // AFD-184: an accept must cover a warning the node has; the error lists the keys it has.
    const reads = await applyOps(
      V2,
      [
        {
          op: 'bind',
          node: 'precheck',
          impl: {
            kind: 'module',
            ref: 'ansible.builtin.debug',
            params: { msg: '{{ ntp_servers }} {{ syslog_host }}' },
          },
        },
      ],
      opts,
    );
    await expect(
      applyOps(
        reads.text,
        [{ op: 'accept', at: 'precheck', finding: 'check:binding-unknown-var:nope', reason: 'x' }],
        opts,
      ),
    ).rejects.toThrow(
      /matches no warning on precheck; its warnings: .*check:binding-unknown-var:ntp_servers/,
    );
    const check = await applyOps(
      reads.text,
      [
        {
          op: 'accept',
          at: 'precheck',
          finding: 'check:binding-unknown-var:ntp_servers',
          reason: 'group_vars',
        },
      ],
      opts,
    );
    expect(decisions(check.text).at(-1)).toMatchObject({
      finding: 'check:binding-unknown-var:ntp_servers',
    });
    const undone = await applyOps(
      check.text,
      [{ op: 'unaccept', at: 'precheck', finding: 'check:binding-unknown-var:ntp_servers' }],
      opts,
    );
    expect(decisions(undone.text)).toEqual(decisions(reads.text));
    const alias = await applyOps(
      V2,
      [{ op: 'leave_open', at: 'validate.failed_hosts', reason: 'Same as accept' }],
      opts,
    );
    expect(decisions(alias.text).at(-1)).toMatchObject({ kind: 'accepted' });
    expect(buildModel(doc(alias.text)).doc.decisions?.length).toBe(decisions(V2).length + 1);
  });
});

describe('external variables (AFD-185)', () => {
  it('update_flow merges flow.external_vars by name; null removes one, or all', async () => {
    const opts = { newId: createIdFactory() };
    const added = await applyOps(
      V2,
      [{ op: 'update_flow', external_vars: { on_behalf_of: 'Kestra', _pe_host: 'the caller' } }],
      opts,
    );
    expect(doc(added.text).flow.external_vars).toEqual({
      on_behalf_of: 'Kestra',
      _pe_host: 'the caller',
    });
    const one = await applyOps(
      added.text,
      [{ op: 'update_flow', external_vars: { _pe_host: null } }],
      opts,
    );
    expect(doc(one.text).flow.external_vars).toEqual({ on_behalf_of: 'Kestra' });
    const none = await applyOps(one.text, [{ op: 'update_flow', external_vars: null }], opts);
    expect(doc(none.text).flow.external_vars).toBeUndefined();
    await expect(
      applyOps(V2, [{ op: 'update_flow', external_vars: { 'not a name': 'x' } }], opts),
    ).rejects.toThrow(/not a variable name/);
  });
});

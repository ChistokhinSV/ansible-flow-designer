// M4 (AFD-6): subflow inner graphs, boundary entry and exits, boundary validation (03, D-23).
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { optionA } from '../../../src/core/engine/optionA';
import { CommandError, type FlowCommand, planCommand } from '../../../src/core/flow/commands';
import { createIdFactory } from '../../../src/core/flow/ids';
import { buildModel } from '../../../src/core/flow/model';
import { createSchemaValidator } from '../../../src/core/flow/schema';
import type { FlowDocument, FlowNode } from '../../../src/core/flow/types';
import { validateFlow } from '../../../src/core/flow/validate';
import { applyEdits } from '../../../src/core/yaml';
import { exampleFlows, readExample } from './helpers';

const EDGE = readExample('edge-baseline.flow.yaml');
const OS = readExample('os-upgrade.flow.yaml');
const schema = createSchemaValidator();
const ctx = { newId: createIdFactory() };

const docOf = (text: string) => parse(text) as FlowDocument;
const apply = (text: string, cmd: FlowCommand) => {
  const r = planCommand(text, cmd, ctx);
  expect(applyEdits(text, r.edits)).toBe(r.text);
  expect(schema(docOf(r.text))).toEqual([]);
  return r;
};
const refuse = (text: string, cmd: FlowCommand, code: string) => {
  try {
    planCommand(text, cmd, ctx);
  } catch (e) {
    expect(e).toBeInstanceOf(CommandError);
    expect((e as CommandError).code).toBe(code);
    return;
  }
  throw new Error(`${cmd.kind} was not refused`);
};
const all = (text: string): FlowNode[] =>
  [...buildModel(docOf(text)).nodes.values()].map((e) => e.node);
const id = (text: string, key: string) => all(text).find((n) => n.key === key)?.id as string;
const nodeOf = (text: string, key: string) => all(text).find((n) => n.key === key) as FlowNode;
const codes = (text: string) => validateFlow(docOf(text)).findings.map((f) => f.code);
const ids = (text: string) =>
  [...text.matchAll(/\b0[0-7][0-9A-HJKMNP-TV-Z]{24}\b/g)].map((m) => m[0]);

describe('boundary validation', () => {
  it('the examples are clean', () => {
    for (const { text } of exampleFlows()) {
      expect(codes(text).filter((c) => /^(boundary|inner-exit)/.test(c))).toEqual([]);
    }
  });

  it('reports a missing entry, an unfed outer port and an inner outcome that leads nowhere', () => {
    const doc = docOf(OS);
    const sub = doc.nodes.find((n) => n.key === 'upgrade-os') as FlowNode;
    const body = sub.subflow as NonNullable<FlowNode['subflow']>;
    delete body.boundary?.in;
    delete body.boundary?.outputs?.ok_hosts;
    const found = validateFlow(doc).findings.filter((f) => /^(boundary|inner-exit)/.test(f.code));
    expect(found.map((f) => `${f.code}:${f.port ?? ''}`).sort()).toEqual([
      'boundary-no-entry:',
      'boundary-port-unfed:ok_hosts',
      'inner-exit-unmapped:ok_hosts',
    ]);
  });

  it('a wrong exit reference is reported', () => {
    const doc = docOf(OS);
    const body = doc.nodes.find((n) => n.key === 'upgrade-os')?.subflow;
    const refs = body?.boundary?.outputs?.ok_hosts ?? [];
    refs.push({ node: body?.nodes?.[0]?.id ?? '', port: 'ok_hosts' }); // also wired inside
    refs.push({ node: body?.nodes?.[0]?.id ?? '', port: 'approved' }); // no such port
    const msgs = validateFlow(doc).findings.filter((f) => f.code === 'boundary-ref');
    expect(msgs).toHaveLength(2);
  });
});

describe('creating an inner graph', () => {
  it('the first inner step creates the subflow block and becomes the entry; the next does not', () => {
    const push = id(EDGE, 'push-baseline');
    const first = apply(EDGE, {
      kind: 'addNode',
      parent: push,
      type: 'task',
      title: 'Render config',
      position: { x: 40, y: 80 },
    });
    const body = nodeOf(first.text, 'push-baseline').subflow;
    expect(body?.nodes?.map((n) => n.key)).toEqual(['render-config']);
    expect(body?.boundary).toEqual({ in: first.created });
    expect(docOf(first.text).layout?.[first.created as string]).toEqual({ x: 40, y: 80 });
    expect(ids(first.text).filter((x) => ids(EDGE).includes(x))).toEqual(ids(EDGE));

    const second = apply(first.text, {
      kind: 'addNode',
      parent: push,
      type: 'task',
      title: 'Push config',
      connectFrom: { node: first.created as string, port: 'ok_hosts' },
    });
    const after = nodeOf(second.text, 'push-baseline').subflow;
    expect(after?.boundary).toEqual({ in: first.created });
    expect(after?.edges).toHaveLength(1);
    expect(codes(second.text)).toContain('inner-exit-unmapped');
  });

  it('only subflow nodes take inner steps; keys are unique per level', () => {
    refuse(
      EDGE,
      { kind: 'addNode', parent: id(EDGE, 'validate'), type: 'task', title: 'X' },
      'bad-type',
    );
    const up = id(OS, 'upgrade-os');
    refuse(
      OS,
      { kind: 'addNode', parent: up, type: 'task', title: 'Reload', key: 'reload' },
      'duplicate-key',
    );
    // The same key as a top-level node is fine inside.
    apply(OS, {
      kind: 'addNode',
      parent: up,
      type: 'task',
      title: 'Pre-checks',
      key: 'pre-checks',
    });
  });
});

describe('boundary commands', () => {
  const up = id(OS, 'upgrade-os');
  const boot = id(OS, 'set-boot-variable');
  const wait = id(OS, 'wait-for-ssh');
  const stage = id(OS, 'stage-image');

  it('an exit enables the outer port when needed, keeps IDs and is one edit', () => {
    const r = apply(OS, {
      kind: 'connectBoundary',
      subflow: up,
      from: { node: boot, port: 'unchanged' },
      port: 'unchanged',
      reason: 'boot variable already set',
    });
    const sub = nodeOf(r.text, 'upgrade-os');
    expect(sub.ports).toContain('unchanged');
    expect(nodeOf(r.text, 'set-boot-variable').ports).toContain('unchanged');
    expect(sub.subflow?.boundary?.outputs?.unchanged).toEqual([
      { node: boot, port: 'unchanged', reason: 'boot variable already set' },
    ]);
    expect(new Set(ids(r.text))).toEqual(new Set(ids(OS)));
    // The exited port is taken: it cannot be wired inside too.
    refuse(
      r.text,
      {
        kind: 'connect',
        from: { node: boot, port: 'unchanged' },
        to: { node: stage, port: 'in' },
      },
      'port-in-use',
    );
    refuse(
      r.text,
      { kind: 'setPortEnabled', node: up, port: 'unchanged', enabled: false },
      'port-connected',
    );
  });

  it('a port wired inside cannot also exit; an exit can be removed and labelled', () => {
    refuse(
      OS,
      {
        kind: 'connectBoundary',
        subflow: up,
        from: { node: stage, port: 'ok_hosts' },
        port: 'ok_hosts',
      },
      'port-in-use',
    );
    const labelled = apply(OS, {
      kind: 'setExitReason',
      subflow: up,
      from: { node: wait, port: 'unreachable' },
      port: 'unreachable',
      reason: 'SSH timeout',
    });
    expect(nodeOf(labelled.text, 'upgrade-os').subflow?.boundary?.outputs?.unreachable).toEqual([
      { node: wait, port: 'unreachable', reason: 'SSH timeout' },
    ]);
    const cleared = apply(labelled.text, {
      kind: 'setExitReason',
      subflow: up,
      from: { node: wait, port: 'unreachable' },
      port: 'unreachable',
      reason: ' ',
    });
    expect(cleared.text).toBe(OS);
    const removed = apply(OS, {
      kind: 'disconnectBoundary',
      subflow: up,
      from: { node: wait, port: 'unreachable' },
      port: 'unreachable',
    });
    const outputs = nodeOf(removed.text, 'upgrade-os').subflow?.boundary?.outputs ?? {};
    expect(Object.keys(outputs)).toEqual(['ok_hosts', 'failed_hosts']);
    // wait-for-ssh · unreachable now bubbles up (ADR-0004), so the outer port is still fed.
    expect(codes(removed.text)).not.toContain('boundary-port-unfed');
    const open = (text: string) => codes(text).filter((c) => c === 'open-fail-port').length;
    expect(open(removed.text)).toBe(open(OS));
  });

  it('the entry can move to another inner step, never outside', () => {
    const r = apply(OS, { kind: 'setBoundaryIn', subflow: up, node: wait });
    expect(nodeOf(r.text, 'upgrade-os').subflow?.boundary?.in).toBe(wait);
    refuse(OS, { kind: 'setBoundaryIn', subflow: up, node: id(OS, 'post-checks') }, 'cross-level');
    const none = apply(OS, { kind: 'setBoundaryIn', subflow: up, node: null });
    expect(codes(none.text)).toContain('boundary-no-entry');
  });

  it('deleting an inner step drops it from the boundary in the same edit', () => {
    const noEntry = apply(OS, { kind: 'deleteNode', id: stage });
    expect(nodeOf(noEntry.text, 'upgrade-os').subflow?.boundary?.in).toBeUndefined();
    const noExit = apply(OS, { kind: 'deleteNode', id: wait });
    expect(
      nodeOf(noExit.text, 'upgrade-os').subflow?.boundary?.outputs?.unreachable,
    ).toBeUndefined();
    expect(codes(noExit.text)).not.toContain('boundary-ref');
  });

  it('deleting a subflow removes the decisions and positions of its inner steps', () => {
    const decided = apply(OS, {
      kind: 'setDecision',
      node: stage,
      port: 'failed_hosts',
      reason: 'Staging fails before any change',
      by: 'Jane Example',
    });
    const moved = apply(decided.text, {
      kind: 'moveNodes',
      positions: { [stage]: { x: 10, y: 20 } },
    });
    const gone = apply(moved.text, { kind: 'deleteNode', id: up });
    expect(gone.text).not.toContain(stage);
    expect(codes(gone.text)).not.toContain('stale-decision');
  });
});

describe('generated code follows the boundary', () => {
  it('a new exit routes the inner port into the parent group', () => {
    const up = id(OS, 'upgrade-os');
    const boot = id(OS, 'set-boot-variable');
    const r = apply(OS, {
      kind: 'connectBoundary',
      subflow: up,
      from: { node: boot, port: 'unchanged' },
      port: 'unchanged',
    });
    const inner = optionA.generate(docOf(r.text), { source: 'os-upgrade.flow.yaml' }).files[1]
      ?.text;
    expect(inner).toContain("'flow_upgrade_os_unchanged' if not boot_result.changed");
  });
});

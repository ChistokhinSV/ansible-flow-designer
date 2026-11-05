import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { CommandError, type FlowCommand, planCommand } from '../../../src/core/flow/commands';
import { elementRangeOf, parseFlow, rangeOf } from '../../../src/core/flow/document';
import { createIdFactory } from '../../../src/core/flow/ids';
import { buildModel } from '../../../src/core/flow/model';
import { openFailPorts } from '../../../src/core/flow/openPorts';
import { PATTERN_IDS } from '../../../src/core/flow/patterns';
import { createSchemaValidator } from '../../../src/core/flow/schema';
import { semanticKey, versionBump } from '../../../src/core/flow/semantic';
import type { FlowDocument } from '../../../src/core/flow/types';
import { validateFlow } from '../../../src/core/flow/validate';
import { applyEdits, lineStart, locate, parseYaml } from '../../../src/core/yaml';
import { exampleFlows, readExample } from './helpers';

const EDGE = readExample('edge-baseline.flow.yaml');
const OS = readExample('os-upgrade.flow.yaml');
const schema = createSchemaValidator();
const ctx = { newId: createIdFactory() };

const docOf = (text: string) => parse(text) as FlowDocument;
const run = (text: string, cmd: FlowCommand) => planCommand(text, cmd, ctx);
const apply = (text: string, cmd: FlowCommand) => {
  const r = run(text, cmd);
  expect(applyEdits(text, r.edits)).toBe(r.text);
  return r;
};
const id = (text: string, key: string) =>
  docOf(text).nodes.find((n) => n.key === key)?.id as string;

describe('load and validate the examples', () => {
  it.each(exampleFlows())('$name: no errors', ({ text }) => {
    const parsed = parseFlow(text);
    expect(parsed.errors).toEqual([]);
    const { findings } = validateFlow(parsed.doc as FlowDocument, schema(parsed.doc));
    expect(findings.filter((f) => f.severity === 'error')).toEqual([]);
  });

  it('edge-baseline: 3 open fail ports (backup-config is open on purpose)', () => {
    const open = openFailPorts(buildModel(docOf(EDGE)));
    expect(open.map((o) => `${o.node}:${o.port}`)).toEqual([
      `${id(EDGE, 'precheck')}:failed_hosts`,
      `${id(EDGE, 'validate')}:failed_hosts`,
      `${id(EDGE, 'rollback')}:failed_hosts`,
    ]);
  });

  it('os-upgrade: 3 open fail ports; inner ports bubble into upgrade-os', () => {
    const open = openFailPorts(buildModel(docOf(OS)));
    expect(open.map((o) => o.node).sort()).toEqual(
      [id(OS, 'restore-traffic'), id(OS, 'notify-on-call'), id(OS, 'rollback')].sort(),
    );
  });

  it('os-upgrade: warns about overclaiming statuses and the undo ports never built (AFD-54)', () => {
    const { findings } = validateFlow(docOf(OS));
    const codes = (code: string) => findings.filter((f) => f.code === code).map((f) => f.node);
    expect(codes('status-overclaim')).toContain(id(OS, 'pre-checks'));
    expect(codes('legacy-port').sort()).toEqual(
      [id(OS, 'backup-config'), id(OS, 'drain-traffic'), id(OS, 'upgrade-os')].sort(),
    );
    const legacy = findings.find((f) => f.code === 'legacy-port');
    expect(legacy?.message).toContain('Upgrade Flow Format removes it and its wires');
  });
});

describe('open fail ports', () => {
  it('counts enabled optional fail ports and honours decisions', () => {
    const doc = docOf(EDGE);
    const pre = doc.nodes.find((n) => n.key === 'precheck');
    if (!pre) throw new Error('fixture');
    pre.ports = ['unreachable'];
    expect(openFailPorts(buildModel(doc))).toHaveLength(4);
    doc.decisions?.push({
      node: pre.id,
      port: 'unreachable',
      kind: 'open_on_purpose',
      reason: 'r',
    });
    expect(openFailPorts(buildModel(doc))).toHaveLength(3);
  });

  it('counts an inner port that cannot bubble (parent lacks that port)', () => {
    const doc = docOf(OS);
    const up = doc.nodes.find((n) => n.key === 'upgrade-os');
    const wait = up?.subflow?.nodes?.find((n) => n.key === 'wait-for-ssh');
    if (!up?.subflow?.boundary?.outputs || !wait) throw new Error('fixture');
    delete up.subflow.boundary.outputs.unreachable;
    expect(openFailPorts(buildModel(doc))).toHaveLength(3); // bubbles: parent has unreachable
    up.ports = ['undo'];
    const open = openFailPorts(buildModel(doc));
    expect(open).toHaveLength(4);
    expect(open.find((o) => o.node === wait.id)).toMatchObject({
      port: 'unreachable',
      level: up.id,
    });
  });
});

describe('commands keep IDs and edges stable (check 1)', () => {
  it('rename rewrites from: references and changes nothing else', () => {
    const backup = id(EDGE, 'backup-config');
    const r = apply(EDGE, {
      kind: 'updateNode',
      id: backup,
      patch: { key: 'save-config', title: 'Save config' },
    });
    const before = docOf(EDGE);
    const after = docOf(r.text);
    expect(after.nodes.map((n) => n.id)).toEqual(before.nodes.map((n) => n.id));
    expect(after.edges).toEqual(before.edges);
    expect(after.nodes.find((n) => n.id === backup)?.key).toBe('save-config');
    const froms = after.nodes.flatMap((n) => Object.values(n.inputs ?? {}).map((f) => f.from));
    expect(froms).toContain('save-config.backup_ref');
    expect(froms).not.toContain('backup-config.backup_ref');
    const changed = r.edits.map((e) =>
      EDGE.slice(lineStart(EDGE, e.start), EDGE.indexOf('\n', e.end)).trim(),
    );
    for (const line of changed) expect(line).toMatch(/^(key|title|from): /);
  });

  it('rename back restores the bytes exactly', () => {
    const backup = id(EDGE, 'backup-config');
    const there = apply(EDGE, {
      kind: 'updateNode',
      id: backup,
      patch: { key: 'x-y', title: 'X' },
    }).text;
    const back = apply(there, {
      kind: 'updateNode',
      id: backup,
      patch: { key: 'backup-config', title: 'Backup config' },
    });
    expect(back.text).toBe(EDGE);
  });

  it('refuses duplicate keys and bad slugs', () => {
    const backup = id(EDGE, 'backup-config');
    expect(() => run(EDGE, { kind: 'updateNode', id: backup, patch: { key: 'validate' } })).toThrow(
      CommandError,
    );
    expect(() => run(EDGE, { kind: 'updateNode', id: backup, patch: { key: 'Bad Key' } })).toThrow(
      /slug/,
    );
  });

  it('add node from a port, then delete it: identical bytes', () => {
    const validate = id(EDGE, 'validate');
    const added = apply(EDGE, {
      kind: 'addNode',
      type: 'task',
      title: 'Notify on-call',
      intent: 'Page the on-call engineer',
      position: { x: 456.4, y: 520 },
      connectFrom: { node: validate, port: 'failed_hosts' },
    });
    const doc = docOf(added.text);
    const created = doc.nodes.find((n) => n.id === added.created);
    expect(created).toMatchObject({ key: 'notify-on-call', type: 'task', status: 'draft' });
    expect(doc.layout?.[added.created as string]).toEqual({ x: 456, y: 520 });
    expect(doc.edges.at(-1)).toMatchObject({
      from: { node: validate, port: 'failed_hosts' },
      to: { node: added.created, port: 'in' },
    });
    expect(schema(doc)).toEqual([]);
    expect(openFailPorts(buildModel(doc))).toHaveLength(3); // validate wired, new node open
    const removed = apply(added.text, { kind: 'deleteNode', id: added.created as string });
    expect(removed.text).toBe(EDGE);
  });

  it('add node with layout in a flow without layout, then delete it: identical bytes', () => {
    const added = apply(OS, {
      kind: 'addNode',
      type: 'end',
      title: 'Aborted',
      outcome: 'failed',
      position: { x: 10, y: 20 },
    });
    expect(docOf(added.text).layout).toEqual({ [added.created as string]: { x: 10, y: 20 } });
    expect(apply(added.text, { kind: 'deleteNode', id: added.created as string }).text).toBe(OS);
  });

  it('wires failed_hosts to an existing Rollback on create', () => {
    const rollback = id(EDGE, 'rollback');
    const r = apply(EDGE, {
      kind: 'addNode',
      type: 'task',
      title: 'Apply',
      wireFailedTo: rollback,
    });
    expect(docOf(r.text).edges.at(-1)).toMatchObject({
      from: { node: r.created, port: 'failed_hosts' },
      to: { node: rollback },
    });
  });

  it('connect checks ports, single output edge and cycles; disconnect restores bytes', () => {
    const pre = id(EDGE, 'precheck');
    const failed = id(EDGE, 'failed');
    const validate = id(EDGE, 'validate');
    const c = apply(EDGE, {
      kind: 'connect',
      from: { node: pre, port: 'failed_hosts' },
      to: { node: failed, port: 'in' },
    });
    expect(openFailPorts(buildModel(docOf(c.text)))).toHaveLength(2);
    expect(apply(c.text, { kind: 'disconnect', edge: c.created as string }).text).toBe(EDGE);
    expect(() =>
      run(EDGE, {
        kind: 'connect',
        from: { node: pre, port: 'ok_hosts' },
        to: { node: failed, port: 'in' },
      }),
    ).toThrow(/already wired/);
    expect(() =>
      run(EDGE, {
        kind: 'connect',
        from: { node: validate, port: 'failed_hosts' },
        to: { node: pre, port: 'in' },
      }),
    ).toThrow(/cycle/);
    expect(() =>
      run(EDGE, {
        kind: 'connect',
        from: { node: pre, port: 'in' },
        to: { node: failed, port: 'in' },
      }),
    ).toThrow(/output/);
  });

  it('enabling an optional port and disabling it again restores bytes', () => {
    const pre = id(EDGE, 'precheck');
    const on = apply(EDGE, {
      kind: 'setPortEnabled',
      node: pre,
      port: 'unreachable',
      enabled: true,
    });
    expect(docOf(on.text).nodes.find((n) => n.id === pre)?.ports).toEqual(['unreachable']);
    expect(
      apply(on.text, { kind: 'setPortEnabled', node: pre, port: 'unreachable', enabled: false })
        .text,
    ).toBe(EDGE);
  });

  it('contract fields: add, rename, remove', () => {
    const validate = id(EDGE, 'validate');
    const added = apply(EDGE, {
      kind: 'setContractField',
      target: validate,
      side: 'outputs',
      name: 'diff_report',
      field: { type: 'dict' },
    });
    expect(docOf(added.text).nodes.find((n) => n.id === validate)?.outputs).toEqual({
      diff_report: { type: 'dict' },
    });
    const removed = apply(added.text, {
      kind: 'setContractField',
      target: validate,
      side: 'outputs',
      name: 'diff_report',
      field: null,
    });
    expect(removed.text).toBe(EDGE);
    const flowIn = apply(EDGE, {
      kind: 'setContractField',
      target: 'flow',
      side: 'inputs',
      name: 'window',
      field: { type: 'string', required: true },
    });
    expect(docOf(flowIn.text).flow.inputs?.window).toEqual({ type: 'string', required: true });
  });

  it('a flow input keeps its description; an empty one removes it (AFD-100)', () => {
    const described = apply(EDGE, {
      kind: 'setContractField',
      target: 'flow',
      side: 'inputs',
      name: 'window',
      field: { type: 'string', required: true, description: 'Maintenance window in UTC' },
    });
    expect(docOf(described.text).flow.inputs?.window).toEqual({
      type: 'string',
      required: true,
      description: 'Maintenance window in UTC',
    });
    // The flow panel's box sends the field again with the new text, or none when emptied.
    const cleared = apply(described.text, {
      kind: 'setContractField',
      target: 'flow',
      side: 'inputs',
      name: 'window',
      field: { type: 'string', required: true, description: '' },
    });
    expect(docOf(cleared.text).flow.inputs?.window).toEqual({ type: 'string', required: true });
  });
});

describe('moving changes only the layout block (check 2)', () => {
  function layoutSpan(text: string): [number, number] {
    const f = parseYaml(text);
    const loc = locate(f, ['layout']);
    const key = loc?.pair?.key as { range: [number, number, number] } | undefined;
    const node = loc?.node as { range: [number, number, number] } | undefined;
    if (!key || !node) throw new Error('no layout block');
    return [lineStart(text, key.range[0]), node.range[2]];
  }

  it('edits lie inside layout: and the semantic content is unchanged', () => {
    const start = id(EDGE, 'start');
    const r = apply(EDGE, { kind: 'moveNodes', positions: { [start]: { x: 200, y: 64 } } });
    const [lo, hi] = layoutSpan(EDGE);
    for (const e of r.edits) expect(e.start >= lo && e.end <= hi).toBe(true);
    expect(semanticKey(docOf(r.text))).toBe(semanticKey(docOf(EDGE)));
    expect(r.edits).toHaveLength(1);
    const back = apply(r.text, { kind: 'moveNodes', positions: { [start]: { x: 140, y: 64 } } });
    expect(back.text).toBe(EDGE);
  });

  it('first move in a flow without layout inserts one layout block before decisions', () => {
    const start = id(OS, 'start');
    const r = apply(OS, { kind: 'moveNodes', positions: { [start]: { x: 1, y: 2 } } });
    expect(r.edits).toHaveLength(1);
    const [e] = r.edits;
    expect(e?.start).toBe(e?.end);
    expect(e?.newText).toBe(`layout:\n  ${start}:\n    x: 1\n    y: 2\n`);
    expect(OS.slice(e?.start).startsWith('decisions:')).toBe(true);
    expect(semanticKey(docOf(r.text))).toBe(semanticKey(docOf(OS)));
  });

  it('a no-op move produces no edits', () => {
    const start = id(EDGE, 'start');
    expect(
      run(EDGE, { kind: 'moveNodes', positions: { [start]: { x: 140, y: 64 } } }).edits,
    ).toEqual([]);
  });
});

describe('random command sequences keep every ID (check 1, property)', () => {
  function mulberry32(seed: number) {
    let a = seed;
    return () => {
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  it.each(exampleFlows())(
    '$name',
    ({ text }) => {
      const rng = mulberry32(text.length);
      let current = text;
      const pick = <T>(xs: T[]) => xs[Math.floor(rng() * xs.length)] as T;
      for (let i = 0; i < 120; i++) {
        const doc = docOf(current);
        const nodes = doc.nodes;
        const node = pick(nodes);
        const r = rng();
        let cmd: FlowCommand;
        // M4: inside subflows too (inner steps, entry, exits, reasons).
        const subflows = nodes.filter((n) => n.type === 'subflow');
        if (subflows.length > 0 && rng() < 0.2) {
          const sub = pick(subflows);
          const inner = sub.subflow?.nodes ?? [];
          const step = inner.length > 0 ? pick(inner) : undefined;
          const s = rng();
          const exits = Object.entries(sub.subflow?.boundary?.outputs ?? {}).flatMap(
            ([port, refs]) =>
              (refs ?? []).map((ref) => ({ port, from: { node: ref.node, port: ref.port } })),
          );
          if (!step || s < 0.3)
            cmd = { kind: 'addNode', parent: sub.id, type: 'task', title: `Inner ${i}` };
          else if (s < 0.5)
            cmd = {
              kind: 'connectBoundary',
              subflow: sub.id,
              from: { node: step.id, port: pick(['ok_hosts', 'failed_hosts', 'unreachable']) },
              port: pick(['ok_hosts', 'failed_hosts', 'unreachable', 'unchanged']),
              reason: rng() < 0.5 ? `why ${i}` : undefined,
            };
          else if (s < 0.6) cmd = { kind: 'setBoundaryIn', subflow: sub.id, node: step.id };
          else if (s < 0.7 && exits.length > 0)
            cmd = { kind: 'disconnectBoundary', subflow: sub.id, ...pick(exits) };
          else if (s < 0.8 && exits.length > 0)
            cmd = { kind: 'setExitReason', subflow: sub.id, ...pick(exits), reason: `r ${i}` };
          else if (s < 0.9) cmd = { kind: 'deleteNode', id: step.id };
          else cmd = { kind: 'moveNodes', positions: { [step.id]: { x: i, y: i * 2 } } };
        } else if (r < 0.3)
          cmd = { kind: 'moveNodes', positions: { [node.id]: { x: rng() * 900, y: rng() * 900 } } };
        else if (r < 0.5)
          cmd = { kind: 'updateNode', id: node.id, patch: { title: `T ${i}`, key: `k-${i}` } };
        else if (r < 0.7)
          cmd = {
            kind: 'addNode',
            type: pick(['task', 'decision', 'end', 'subflow'] as const),
            title: `New ${i}`,
            position: { x: i, y: i },
          };
        else if (r < 0.78 && nodes.length > 4) cmd = { kind: 'deleteNode', id: node.id };
        else if (r < 0.84)
          cmd = {
            kind: 'applyPattern',
            pattern: pick([...PATTERN_IDS]),
            from: {
              node: node.id,
              port: pick(['failed_hosts', 'unreachable', 'ok_hosts', 'true']),
            },
            position: { x: i * 7, y: i * 3 },
          };
        else if (r < 0.88)
          cmd = { kind: 'setDecision', node: node.id, port: 'failed_hosts', reason: `r ${i}` };
        else if (r < 0.9) cmd = { kind: 'clearDecision', node: node.id, port: 'failed_hosts' };
        else if (r < 0.93 && doc.edges.length > 0)
          cmd = {
            kind: 'rewire',
            edge: pick(doc.edges).id,
            to: { node: pick(nodes).id, port: 'in' },
          };
        else
          cmd = {
            kind: 'connect',
            from: { node: node.id, port: 'failed_hosts' },
            to: { node: pick(nodes).id, port: 'in' },
          };

        let result: ReturnType<typeof run>;
        try {
          result = apply(current, cmd);
        } catch (e) {
          expect(e).toBeInstanceOf(CommandError);
          continue;
        }
        const next = docOf(result.text);
        expect(schema(next), `step ${i} ${cmd.kind}`).toEqual([]);
        expect(next.flow.id).toBe(doc.flow.id);
        const deleted = cmd.kind === 'deleteNode' ? cmd.id : undefined;
        const nextNodes = new Map(next.nodes.map((n) => [n.id, n]));
        for (const n of nodes)
          if (n.id !== deleted) expect(nextNodes.has(n.id), `step ${i} lost ${n.id}`).toBe(true);
        const nextEdges = new Map(next.edges.map((e) => [e.id, e]));
        for (const e of doc.edges) {
          if (deleted && (e.from.node === deleted || e.to.node === deleted)) continue;
          // Rewiring keeps the edge and its source; only the target moves.
          const expected = cmd.kind === 'rewire' && cmd.edge === e.id ? { ...e, to: cmd.to } : e;
          expect(nextEdges.get(e.id), `step ${i} edge ${e.id}`).toEqual(expected);
        }
        const { findings } = validateFlow(next);
        expect(
          findings.filter((f) =>
            ['duplicate-id', 'duplicate-key', 'edge-missing-node', 'boundary-ref'].includes(f.code),
          ),
        ).toEqual([]);
        current = result.text;
      }
    },
    60_000,
  );
});

describe('version bump (ADR-0006)', () => {
  it('bumps once relative to the base, never for layout-only changes', () => {
    const base = docOf(EDGE);
    const moved = structuredClone(base);
    if (moved.layout) moved.layout[base.nodes[0]?.id as string] = { x: 1, y: 1 };
    expect(versionBump(moved, base)).toBeUndefined();
    const changed = structuredClone(base);
    (changed.nodes[1] as { title: string }).title = 'Pre-checks v2';
    expect(versionBump(changed, base)).toBe(4);
    changed.flow.version = 4;
    expect(versionBump(changed, base)).toBeUndefined();
    expect(versionBump(changed, undefined)).toBeUndefined();
  });
});

describe('diagnostic ranges', () => {
  it('narrows a node to its first line and finds nested fields', () => {
    const f = parseYaml(EDGE);
    const [s, e] = rangeOf(f, ['nodes', 1]);
    expect(EDGE.slice(s, e)).toBe('id: 01JBQKFBF5KZNWJ47TAN9ZT24M');
    const [s2, e2] = rangeOf(f, ['nodes', 1, 'status']);
    expect(EDGE.slice(s2, e2)).toBe('draft');
    const [s3, e3] = rangeOf(f, ['nodes', 1, 'missing', 'deeper']);
    expect(EDGE.slice(s3, e3)).toBe('id: 01JBQKFBF5KZNWJ47TAN9ZT24M');
  });

  it('Open in Text Editor takes the whole element, in full lines, and nothing after it', () => {
    const f = parseYaml(EDGE);
    const [s, e] = elementRangeOf(f, ['nodes', 1]);
    const lines = EDGE.slice(s, e).split('\n');
    expect(lines[0]).toBe('- id: 01JBQKFBF5KZNWJ47TAN9ZT24M');
    expect(lines.at(-1)).toBe('  impl: null');
    expect(lines).toHaveLength(14);
    // A field is its whole line; a path that leads nowhere falls back to the finding range.
    const [s2, e2] = elementRangeOf(f, ['nodes', 1, 'status']);
    expect(EDGE.slice(s2, e2)).toBe('  status: draft');
    const [s3, e3] = elementRangeOf(f, ['nodes', 1, 'missing']);
    expect(EDGE.slice(s3, e3)).toBe('id: 01JBQKFBF5KZNWJ47TAN9ZT24M');
  });
});

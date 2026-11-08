// AFD-162 and AFD-164 (code review Lows): large flows stay fast, and small host-side rules hold.
import { describe, expect, it } from 'vitest';
import { parse, parseDocument, stringify } from 'yaml';
import { drawioFile, drawioPages, toDrawio } from '../../../src/core/export/drawio';
import { scenesOf } from '../../../src/core/export/scene';
import { predecessors, successors } from '../../../src/core/flow/adjacency';
import { planCommand } from '../../../src/core/flow/commands';
import { createIdFactory } from '../../../src/core/flow/ids';
import { buildModel } from '../../../src/core/flow/model';
import { openFailPorts } from '../../../src/core/flow/openPorts';
import type { FlowDocument } from '../../../src/core/flow/types';
import { addMarks, type OutsideMarks } from '../../../src/core/view/outsideChanges';
import { applyEdits, diffEdits } from '../../../src/core/yaml/edits';
import { readExample } from './helpers';

const ctx = { newId: createIdFactory() };

/** A format 2 flow of `n` chained draft steps between a start and an end, written as YAML. */
function chain(n: number): { text: string; ids: string[] } {
  const id = createIdFactory();
  const start = { id: id(), key: 'start', type: 'start', title: 'Start' };
  const steps = Array.from({ length: n }, (_, i) => ({
    id: id(),
    key: `step-${i}`,
    type: 'task',
    title: `Step ${i}`,
    status: 'draft',
  }));
  const end = { id: id(), key: 'done', type: 'end', title: 'Done', outcome: 'success' };
  const nodes = [start, ...steps, end];
  const edges = nodes.slice(1).map((to, i) => ({
    id: id(),
    from: { node: nodes[i]?.id, port: i === 0 ? 'ok_hosts' : 'ok_hosts' },
    to: { node: to.id, port: 'in' },
  }));
  const layout = Object.fromEntries(nodes.map((nd, i) => [nd.id, { x: 0, y: i * 120 }]));
  const doc = {
    schema_version: 2,
    flow: { id: id(), key: 'big', name: 'Big', version: '1.0.0' },
    nodes,
    edges,
    layout,
  };
  return { text: stringify(doc, { lineWidth: 0 }), ids: steps.map((s) => s.id) };
}

describe('AFD-162: large flows', () => {
  it('a selection deletes as one edit with the same result as node by node', () => {
    const { text, ids } = chain(40);
    const picked = ids.filter((_, i) => i % 3 === 0);
    const once = planCommand(text, { kind: 'deleteNodes', ids: picked }, ctx).text;
    let each = text;
    for (const id of picked) each = planCommand(each, { kind: 'deleteNodes', ids: [id] }, ctx).text;
    expect(parse(once)).toEqual(parse(each));
    const left = parse(once) as FlowDocument;
    expect(left.nodes).toHaveLength(42 - picked.length);
    expect(Object.keys(left.layout ?? {})).toHaveLength(42 - picked.length);
  });

  it('select-all and delete on 400 steps takes one parse, not one per step', () => {
    const { text, ids } = chain(400);
    const t0 = performance.now();
    const out = parse(planCommand(text, { kind: 'deleteNodes', ids }, ctx).text) as FlowDocument;
    const ms = performance.now() - t0;
    expect(out.nodes).toHaveLength(2);
    expect(out.edges ?? []).toHaveLength(0);
    // Node by node this was seconds (400 parses and models of a 400-step flow).
    expect(ms).toBeLessThan(3000);
  });

  it('a flow-style layout map still deletes (node by node when the batch would overlap)', () => {
    const { text, ids } = chain(6);
    const doc = parseDocument(text);
    (doc.get('layout') as { flow: boolean }).flow = true;
    const flowStyle = doc.toString({ lineWidth: 0 });
    const out = parse(
      planCommand(flowStyle, { kind: 'deleteNodes', ids: ids.slice(0, 3) }, ctx).text,
    ) as FlowDocument;
    expect(out.nodes).toHaveLength(5);
    expect(Object.keys(out.layout ?? {})).toHaveLength(5);
  });

  it('the line diff gives back the new text, and trims what did not change', () => {
    let seed = 7;
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed / 2 ** 31;
    };
    const lines = (n: number) =>
      Array.from({ length: n }, () => `${'abc'[Math.floor(rnd() * 3)]}\n`).join('');
    for (let i = 0; i < 200; i++) {
      const before = lines(Math.floor(rnd() * 30));
      const after = lines(Math.floor(rnd() * 30));
      expect(applyEdits(before, diffEdits(before, after))).toBe(after);
    }
    const big = Array.from({ length: 50_000 }, (_, i) => `line ${i}\n`);
    const changed = [...big];
    changed[25_000] = 'changed\n';
    const t0 = performance.now();
    const edits = diffEdits(big.join(''), changed.join(''));
    expect(performance.now() - t0).toBeLessThan(1000);
    expect(edits).toHaveLength(1);
    expect(applyEdits(big.join(''), edits)).toBe(changed.join(''));
  });

  it('images of every level embed the same draw.io file as drawing it per level', () => {
    const doc = parse(readExample('os-upgrade.flow.yaml')) as FlowDocument;
    const src = {
      doc,
      shown: { stored: doc.layout ?? {}, auto: {} },
      findings: [],
      openPorts: openFailPorts(buildModel(doc)),
    };
    const drawn = drawioPages(src);
    const scenes = scenesOf(src);
    expect(scenes.length).toBeGreaterThan(1);
    for (const s of scenes)
      expect(drawioFile(drawn, { first: s.level })).toBe(toDrawio(src, { first: s.level }));
  });

  it('wires by node, built once per list', () => {
    const edges = [
      { from: { node: 'a', port: 'ok_hosts' }, to: { node: 'b', port: 'in' } },
      { from: { node: 'a', port: 'failed_hosts' }, to: { node: 'c', port: 'in' } },
      { from: { node: 'b', port: 'ok_hosts' }, to: { node: 'c', port: 'in' } },
    ];
    expect(successors(edges, 'a')).toEqual(['b', 'c']);
    expect(predecessors(edges, 'c')).toEqual(['a', 'b']);
    expect(successors(edges, 'c')).toEqual([]);
  });
});

describe('AFD-164: outside changes', () => {
  it('a step added and then removed outside is no step removed', () => {
    const doc = parse(readExample('edge-baseline.flow.yaml')) as FlowDocument;
    const added: OutsideMarks = {
      nodes: ['01X'],
      edges: [],
      removed: 0,
      since: '2026-11-08T10:00:00Z',
      changes: [{ id: '01X', kind: 'added', title: 'Temp', where: [], fields: [] }],
    };
    const after = addMarks(
      added,
      {
        nodes: [],
        edges: [],
        removed: 1,
        changes: [{ id: '01X', kind: 'removed', title: 'Temp', where: [], fields: [] }],
      },
      doc,
      '2026-11-08T10:05:00Z',
    );
    expect(after?.removed ?? 0).toBe(0);
    expect(after?.changes ?? []).toEqual([]);
  });
});

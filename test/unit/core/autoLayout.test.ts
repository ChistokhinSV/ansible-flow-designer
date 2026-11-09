// AFD-23: positions the canvas shows for nodes the layout block does not place. A flow with only the
// old New Flow template's Start and Done placed, filled by an AI agent, stood in one column with
// siblings on top of each other; agent additions to an arranged flow did the same.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { flowLayoutProblems } from '../../../src/core/export/layoutCheck';
import { NODE_WIDTH, nodeSize } from '../../../src/core/flow/geometry';
import { createIdFactory } from '../../../src/core/flow/ids';
import { buildModel, ROOT } from '../../../src/core/flow/model';
import { newFlowText } from '../../../src/core/flow/template';
import type { FlowDocument, Layout, Position } from '../../../src/core/flow/types';
import {
  autoPositions,
  layoutLevel,
  shownLayout,
  shownPositions,
} from '../../../src/node/autoLayout';
import { readExample } from './helpers';

const sample = () =>
  parse(
    readFileSync(join(__dirname, '../../../samples/firewall-upgrade.flow.yaml'), 'utf8'),
  ) as FlowDocument;

/** Every node's box on a level, from the stored layout and the auto positions. */
async function boxes(doc: FlowDocument, layout: Layout | undefined) {
  const level = buildModel(doc).levels.get(ROOT);
  if (!level) throw new Error('no top level');
  const auto = await autoPositions(level, layout);
  return level.nodes.map((n) => {
    const p = (layout?.[n.id] ?? auto[n.id]) as Position;
    return { key: n.key, ...p, ...nodeSize(n.type) };
  });
}

function overlapping(bs: Awaited<ReturnType<typeof boxes>>): string[] {
  const out: string[] = [];
  for (const [i, a] of bs.entries())
    for (const b of bs.slice(i + 1))
      if (
        a.x < b.x + b.width &&
        a.x + a.width > b.x &&
        a.y < b.y + b.height &&
        a.y + a.height > b.y
      )
        out.push(`${a.key}/${b.key}`);
  return out;
}

describe('auto positions (AFD-23)', () => {
  it('a new flow stores no positions: the canvas lays it out', () => {
    expect(parse(newFlowText('NTP baseline', 'ntp-baseline', createIdFactory())).layout).toBe(
      undefined,
    );
  });

  it('the reported shape: only the old template Start and Done placed, the rest added by an agent', async () => {
    const doc = sample();
    const start = doc.nodes.find((n) => n.type === 'start');
    const done = doc.nodes.find((n) => n.key === 'done');
    if (!start || !done) throw new Error('fixture');
    doc.layout = { [start.id]: { x: 0, y: 0 }, [done.id]: { x: 36, y: 160 } };
    // The view drops the template positions, so the whole level is laid out by ELK.
    const layout = shownLayout(buildModel(doc));
    expect(layout).toEqual({});
    const bs = await boxes(doc, layout);
    expect(overlapping(bs)).toEqual([]);
    // Not one column: the failure handlers stand beside the happy path.
    expect(new Set(bs.map((b) => b.x)).size).toBeGreaterThan(2);
    // The stored layout itself is left as it is.
    expect(Object.keys(doc.layout)).toHaveLength(2);
  });

  it('positions someone chose are kept; only exactly the template is ignored', () => {
    const doc = sample();
    const start = doc.nodes.find((n) => n.type === 'start');
    const done = doc.nodes.find((n) => n.key === 'done');
    if (!start || !done) throw new Error('fixture');
    doc.layout = { [start.id]: { x: 0, y: 0 }, [done.id]: { x: 40, y: 900 } };
    expect(shownLayout(buildModel(doc))).toBe(doc.layout);
  });

  it('nodes an agent adds to an arranged flow go beside their neighbours, overlapping nothing', async () => {
    const doc = parse(readExample('edge-baseline.flow.yaml')) as FlowDocument;
    const layout = { ...doc.layout } as Layout;
    const stored = Object.keys(layout).length;
    // Three nodes without positions, as an agent's edit leaves them.
    const unplaced = doc.nodes.filter((n) => n.type === 'task').slice(0, 3);
    for (const n of unplaced) delete layout[n.id];
    expect(Object.keys(layout)).toHaveLength(stored - 3);
    const bs = await boxes(doc, layout);
    expect(overlapping(bs)).toEqual([]);
    // Each added node still sits below the node that leads to it.
    for (const n of unplaced) {
      const from = doc.edges.find((e) => e.to.node === n.id)?.from.node;
      const me = bs.find((b) => b.key === n.key);
      const pred = bs.find((b) => b.key === doc.nodes.find((x) => x.id === from)?.key);
      if (me && pred) expect(me.y, n.key).toBeGreaterThan(pred.y);
    }
  });
});

/** A flow from node keys and types and wires `[from, port, to]`, with no stored positions. */
function flow(nodes: [string, string][], wires: [string, string, string][]): FlowDocument {
  return {
    schema_version: 2,
    flow: { id: 'f', key: 'f', name: 'f', version: 1 },
    nodes: nodes.map(([key, type]) => ({ id: `n-${key}`, key, type, title: key })),
    edges: wires.map(([from, port, to], i) => ({
      id: `e-${i}`,
      from: { node: `n-${from}`, port },
      to: { node: `n-${to}`, port: 'in' },
    })),
  } as unknown as FlowDocument;
}

/** Auto positions by key and the layout check's problem kinds, as flow_describe layout: true. */
async function checked(doc: FlowDocument) {
  const model = buildModel(doc);
  const shown = await shownPositions(model);
  const at = (key: string) => shown.auto[`n-${key}`] as Position;
  const problems = flowLayoutProblems(model, shown).get(ROOT) ?? [];
  return { at, problems, kinds: new Set(problems.map((p) => p.kind)) };
}

describe('auto layout with the canvas ports (AFD-192)', () => {
  // The false wire first, as an agent's batch left it: ELK's own bottom ports then came in wire
  // order and put the true target under the canvas's false handle, the two labels in one gap.
  const decisionSkip = () =>
    flow(
      [
        ['start', 'start'],
        ['check', 'task'],
        ['decide', 'decision'],
        ['fix', 'task'],
        ['verify', 'task'],
        ['done', 'end'],
      ],
      [
        ['verify', 'ok_hosts', 'done'],
        ['fix', 'ok_hosts', 'verify'],
        ['decide', 'false', 'verify'],
        ['decide', 'true', 'fix'],
        ['check', 'ok_hosts', 'decide'],
        ['start', 'ok_hosts', 'check'],
      ],
    );

  it('a decision whose false skips its true step: no labels on each other, no wire through a node', async () => {
    const { at, problems, kinds } = await checked(decisionSkip());
    expect(kinds.has('labels'), JSON.stringify(problems)).toBe(false);
    expect(kinds.has('through'), JSON.stringify(problems)).toBe(false);
    // The true step hangs from the true handle (1/3 along the bottom), its in port (the middle).
    expect(at('fix').x + NODE_WIDTH / 2).toBe(at('decide').x + Math.round(NODE_WIDTH / 3));
  });

  it('a rescue fed by three failed_hosts sits right of the column it handles, its wires across nothing', async () => {
    const { at, problems, kinds } = await checked(
      flow(
        [
          ['start', 'start'],
          ['s1', 'task'],
          ['s2', 'task'],
          ['s3', 'task'],
          ['capture', 'task'],
          ['after', 'task'],
          ['done', 'end'],
        ],
        [
          ['start', 'ok_hosts', 's1'],
          ['s1', 'ok_hosts', 's2'],
          ['s2', 'ok_hosts', 's3'],
          ['s3', 'ok_hosts', 'after'],
          ['s1', 'failed_hosts', 'capture'],
          ['s2', 'failed_hosts', 'capture'],
          ['s3', 'failed_hosts', 'capture'],
          ['capture', 'ok_hosts', 'after'],
          ['after', 'ok_hosts', 'done'],
        ],
      ),
    );
    expect(kinds.has('cross'), JSON.stringify(problems)).toBe(false);
    expect(kinds.has('label'), JSON.stringify(problems)).toBe(false);
    expect(kinds.has('through'), JSON.stringify(problems)).toBe(false);
    // One straight column; the rescue's in port (and the wires into it) right of it.
    const column = ['s1', 's2', 's3', 'after'].map(at);
    expect(new Set(column.map((p) => p.x)).size).toBe(1);
    const right = Math.max(...column.map((p) => p.x + NODE_WIDTH));
    expect(at('capture').x + NODE_WIDTH / 2).toBeGreaterThan(right);
    expect(at('capture').y).toBeGreaterThan(at('s3').y);
  });

  it('left to right too: every node placed, along the flow, none on another', async () => {
    const doc = decisionSkip();
    const level = buildModel(doc).levels.get(ROOT);
    if (!level) throw new Error('no top level');
    const at = await layoutLevel(level, 'LR');
    expect(Object.keys(at)).toHaveLength(doc.nodes.length);
    const p = (key: string) => at[`n-${key}`] as Position;
    expect(p('start').x).toBeLessThan(p('check').x);
    expect(p('verify').x).toBeLessThan(p('done').x);
    const bs = doc.nodes.map((n) => ({ key: n.key, ...p(n.key), ...nodeSize(n.type) }));
    expect(overlapping(bs)).toEqual([]);
  });
});

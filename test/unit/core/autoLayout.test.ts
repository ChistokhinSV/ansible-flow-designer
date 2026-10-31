// AFD-23: positions the canvas shows for nodes the layout block does not place. A flow with only the
// old New Flow template's Start and Done placed, filled by an AI agent, stood in one column with
// siblings on top of each other; agent additions to an arranged flow did the same.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { nodeSize } from '../../../src/core/flow/geometry';
import { createIdFactory } from '../../../src/core/flow/ids';
import { buildModel, ROOT } from '../../../src/core/flow/model';
import { newFlowText } from '../../../src/core/flow/template';
import type { FlowDocument, Layout, Position } from '../../../src/core/flow/types';
import { autoPositions, shownLayout } from '../../../src/extension/autoLayout';
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

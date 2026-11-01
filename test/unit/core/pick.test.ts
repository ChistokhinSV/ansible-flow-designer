// AFD-47: the nodes a keyboard pick walks, in reading order, and the step that wraps at the ends.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { buildModel, ROOT } from '../../../src/core/flow/model';
import type { FlowDocument } from '../../../src/core/flow/types';
import { pickCandidates, stepPick } from '../../../src/core/view/pick';

const doc = parse(
  readFileSync(join(__dirname, '../../../examples/edge-baseline.flow.yaml'), 'utf8'),
) as FlowDocument;
const model = buildModel(doc);
const id = (key: string) => doc.nodes.find((n) => n.key === key)?.id as string;
const keys = (ids: string[]) => ids.map((i) => doc.nodes.find((n) => n.id === i)?.key);
const nodes = (model.levels.get(ROOT)?.nodes ?? []).map((node) => ({
  node,
  position: doc.layout?.[node.id] ?? { x: 0, y: 0 },
}));

describe('keyboard pick', () => {
  it('wiring to: every node with an `in` port but the source, top to bottom, then left to right', () => {
    const list = pickCandidates(model, nodes, { mode: 'to', node: id('validate') });
    expect(keys(list)).not.toContain('validate');
    expect(keys(list)).not.toContain('start');
    const at = list.map((i) => nodes.find((n) => n.node.id === i)?.position);
    for (let k = 1; k < at.length; k++) {
      const [a, b] = [at[k - 1], at[k]];
      expect(a && b && (a.y < b.y || (a.y === b.y && a.x <= b.x))).toBe(true);
    }
  });

  it('wiring from: only nodes with a free output', () => {
    const list = keys(pickCandidates(model, nodes, { mode: 'from', node: id('rollback') }));
    expect(list).not.toContain('done');
    expect(list).not.toContain('failed');
    expect(list).not.toContain('rollback');
  });

  it('steps wrap at both ends and start from either end', () => {
    expect(stepPick(['a', 'b', 'c'], null, 1)).toBe('a');
    expect(stepPick(['a', 'b', 'c'], null, -1)).toBe('c');
    expect(stepPick(['a', 'b', 'c'], 'c', 1)).toBe('a');
    expect(stepPick(['a', 'b', 'c'], 'a', -1)).toBe('c');
    expect(stepPick([], null, 1)).toBeUndefined();
  });
});

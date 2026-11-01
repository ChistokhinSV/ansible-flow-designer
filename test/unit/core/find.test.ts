// AFD-48: find a node on any level by title, key or binding; best match first, with its trail.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { buildModel, ROOT } from '../../../src/core/flow/model';
import type { FlowDocument } from '../../../src/core/flow/types';
import { findNodes } from '../../../src/core/view/find';

const doc = parse(
  readFileSync(join(__dirname, '../../../examples/os-upgrade.flow.yaml'), 'utf8'),
) as FlowDocument;
const model = buildModel(doc);
const inner = [...model.nodes.values()].find((e) => e.level !== ROOT && e.node.type === 'task');

describe('find a node', () => {
  it('finds a step inside a subflow and says which subflows it is in', () => {
    if (!inner) throw new Error('the sample has no step inside a subflow');
    const [first] = findNodes(model, inner.node.title);
    expect(first?.id).toBe(inner.node.id);
    expect(first?.level).toBe(inner.level);
    expect(first?.trail.at(-1)).toBe(model.nodes.get(inner.level)?.node.title);
  });

  it('matches keys and bindings too, every word somewhere, a title start first', () => {
    const bound = [...model.nodes.values()].find((e) => e.node.impl?.ref)?.node;
    if (!bound?.impl) throw new Error('the sample has no bound node');
    expect(findNodes(model, bound.impl.ref).map((f) => f.id)).toContain(bound.id);
    const byKey = findNodes(model, bound.key ?? '');
    expect(byKey.map((f) => f.id)).toContain(bound.id);
    const word = bound.title.split(' ')[0] as string;
    const found = findNodes(model, word);
    expect(found[0]?.title.toLowerCase().startsWith(word.toLowerCase())).toBe(true);
    expect(findNodes(model, `${word} zzz-no-such-word`)).toEqual([]);
    expect(findNodes(model, '   ')).toEqual([]);
  });
});

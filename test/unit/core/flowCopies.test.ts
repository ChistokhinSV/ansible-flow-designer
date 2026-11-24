// AFD-378: a flow copied as a file shares its flow ID (and node IDs) with the original; the quick
// fix gives the copy new ones everywhere they are written.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { createIdFactory } from '../../../src/core/flow/ids';
import { keyFromFile, sharedIds, withNewIds } from '../../../src/core/flow/newIds';
import type { FlowDocument } from '../../../src/core/flow/types';
import { importLine, subflowCount } from '../../../src/core/import/result';

const HELLO = readFileSync(join(__dirname, '../../../samples/hello.flow.yaml'), 'utf8');
const ULID = /\b[0-9A-HJKMNP-TV-Z]{26}\b/g;

describe('withNewIds', () => {
  it('replaces every ID the flow holds, wherever it is written, and keeps the rest', () => {
    const copy = withNewIds(HELLO, createIdFactory(), 'c9-hello') as string;
    const before = new Set(HELLO.match(ULID));
    const after = new Set(copy.match(ULID));
    expect(after.size).toBe(before.size);
    for (const id of after) expect(before.has(id)).toBe(false);
    const a = parse(HELLO) as FlowDocument;
    const b = parse(copy) as FlowDocument;
    expect(b.flow.key).toBe('c9-hello');
    expect(b.flow.name).toBe(a.flow.name);
    expect(b.nodes.map((n) => n.key)).toEqual(a.nodes.map((n) => n.key));
    // Wires still join the same steps.
    const keyOf = (d: FlowDocument, id: string) => d.nodes.find((n) => n.id === id)?.key;
    const wires = (d: FlowDocument) =>
      (d.edges ?? []).map((e) => `${keyOf(d, e.from.node)}.${e.from.port}>${keyOf(d, e.to.node)}`);
    expect(wires(b)).toEqual(wires(a));
    // Without a key, the key stays.
    expect((parse(withNewIds(HELLO, createIdFactory()) as string) as FlowDocument).flow.key).toBe(
      'hello',
    );
  });

  it('a key from the file name, and only shared IDs are reported', () => {
    expect(keyFromFile('c9-hello.flow.yaml')).toBe('c9-hello');
    const shared = sharedIds([{ id: 'A', f: 1 }, { id: 'A', f: 2 }, { id: 'B', f: 3 }, { f: 4 }]);
    expect([...shared.keys()]).toEqual(['A']);
    expect(shared.get('A')?.map((x) => x.f)).toEqual([1, 2]);
  });
});

describe('AFD-378: the import notice counts as Readiness does', () => {
  it('names the subflows, so its nodes match Readiness', () => {
    const c = { steps: 20, implemented: 20, drafts: 0 };
    expect(importLine('site.flow.yaml', c, 8)).toBe(
      'Imported site.flow.yaml: 28 nodes (20 steps in 8 subflows); 20 steps ready to run, 0 to check.',
    );
    expect(importLine('a.flow.yaml', { steps: 1, implemented: 1, drafts: 0 })).toBe(
      'Imported a.flow.yaml: 1 step; 1 step ready to run, 0 to check.',
    );
    const doc = parse(HELLO) as FlowDocument;
    expect(subflowCount(doc)).toBe(0);
  });
});

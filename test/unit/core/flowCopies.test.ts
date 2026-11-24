// AFD-378: a flow copied as a file shares its flow ID (and node IDs) with the original; the quick
// fix gives the copy new ones everywhere they are written.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { createIdFactory } from '../../../src/core/flow/ids';
import { modelOf } from '../../../src/core/flow/model';
import { copiesAmong, keyFromFile, sharedIds, withNewIds } from '../../../src/core/flow/newIds';
import type { FlowDocument } from '../../../src/core/flow/types';
import { importPlaybook } from '../../../src/core/import/playbook';
import { importLine, nodeTally } from '../../../src/core/import/result';
import { readPlaybook } from '../../../src/core/import/source';
import { fsSource } from './helpers';

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

describe('AFD-378, AFD-380: the import notice counts as Readiness does', () => {
  it('counts every node Readiness counts: subflows and decisions too', async () => {
    const root = join(__dirname, '../../../samples/playbooks/edge-baseline');
    const read = await readPlaybook(fsSource(root), 'site.yml');
    const r = importPlaybook(
      read.playbook as NonNullable<typeof read.playbook>,
      { key: 'site', newId: createIdFactory(), generatedDir: 'flows/site/generated' },
      read.notes,
    );
    const tally = nodeTally(r.doc);
    const readiness = [...modelOf(r.doc).nodes.values()].filter(
      ({ node }) => node.type !== 'start' && node.type !== 'end',
    ).length;
    expect(tally.total).toBe(readiness);
    const line = importLine('site.flow.yaml', r.counts, tally);
    expect(line.startsWith(`Imported site.flow.yaml: ${readiness} nodes (20 steps, `)).toBe(true);
    expect(line).toBe(
      'Imported site.flow.yaml: 28 nodes (20 steps, 7 subflows, 1 decision); 20 steps ready to run, 0 to check.',
    );
    expect(importLine('a.flow.yaml', { steps: 1, implemented: 1, drafts: 0 })).toBe(
      'Imported a.flow.yaml: 1 step; 1 step ready to run, 0 to check.',
    );
    expect(nodeTally(parse(HELLO) as FlowDocument).others).toEqual({});
  });
});

describe('AFD-380: only the copy is flagged, not the original', () => {
  it('Git first: the files it does not track are the copies', () => {
    const group = [
      { n: 'orig', tracked: true, born: 300 },
      { n: 'copy', tracked: false, born: 100 },
    ];
    expect(copiesAmong(group).map((f) => f.n)).toEqual(['copy']);
  });
  it('without Git, or when Git tracks both, the newer file is the copy', () => {
    expect(
      copiesAmong([
        { n: 'copy', born: 200 },
        { n: 'orig', born: 100 },
      ]).map((f) => f.n),
    ).toEqual(['copy']);
    expect(
      copiesAmong([
        { n: 'orig', tracked: true, born: 100 },
        { n: 'copy', tracked: true, born: 200 },
        { n: 'copy2', tracked: true, born: 300 },
      ]).map((f) => f.n),
    ).toEqual(['copy', 'copy2']);
  });
  it('flags every file when nothing tells them apart', () => {
    expect(copiesAmong([{ born: 0 }, { born: 100 }])).toHaveLength(2);
    expect(copiesAmong([{ born: 100 }, { born: 100 }])).toHaveLength(2);
  });
});

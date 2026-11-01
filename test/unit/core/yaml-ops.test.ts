import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import {
  applyEdits,
  deleteKey,
  diffEdits,
  insertItem,
  type OpResult,
  parseYaml,
  removeItem,
  setIn,
  YamlTransaction,
} from '../../../src/core/yaml';
import { readExample } from './helpers';

const yamlFixture = (name: string) =>
  readFileSync(join(__dirname, '../../fixtures/yaml', name), 'utf8');

function run(text: string, op: (f: ReturnType<typeof parseYaml>) => OpResult): string {
  const res = op(parseYaml(text));
  if (!res.ok) throw new Error(`${res.code}: ${res.reason}`);
  return applyEdits(text, res.edits);
}

describe('setIn', () => {
  it('replaces a scalar in place and keeps its trailing comment', () => {
    const out = run('a: 1 # keep\nb: 2\n', (f) => setIn(f, ['a'], 42));
    expect(out).toBe('a: 42 # keep\nb: 2\n');
  });

  it('quotes strings that would read back as something else', () => {
    const src = 'p: x\n';
    expect(run(src, (f) => setIn(f, ['p'], 'true'))).toBe("p: 'true'\n");
    expect(run(src, (f) => setIn(f, ['p'], 'yes'))).toBe("p: 'yes'\n");
    expect(run(src, (f) => setIn(f, ['p'], '[USER]'))).toBe("p: '[USER]'\n");
    expect(run(src, (f) => setIn(f, ['p'], "it's: here"))).toBe("p: 'it''s: here'\n");
    expect(run(src, (f) => setIn(f, ['p'], '0o17'))).toBe("p: '0o17'\n");
    expect(run(src, (f) => setIn(f, ['p'], 'OS upgrade · edge'))).toBe('p: OS upgrade · edge\n');
  });

  it('keeps the quote style of the old scalar', () => {
    expect(run('p: "old"\n', (f) => setIn(f, ['p'], 'new'))).toBe('p: "new"\n');
    expect(run("p: 'old'\n", (f) => setIn(f, ['p'], 'new'))).toBe("p: 'new'\n");
  });

  it('replaces a multi-line plain scalar with a single line', () => {
    const text = yamlFixture('styles.yaml');
    const out = run(text, (f) => setIn(f, ['plain_multi'], 'gamma'));
    expect(parse(out).plain_multi).toBe('gamma');
    expect(out).toContain('plain_multi: gamma\nnested:');
  });

  it('adds a missing key at the end of a block map, at its indentation', () => {
    const out = run('m:\n  a: 1\nz: 0\n', (f) => setIn(f, ['m', 'b'], 2));
    expect(out).toBe('m:\n  a: 1\n  b: 2\nz: 0\n');
  });

  it('creates missing parent maps (first layout block appended at EOF)', () => {
    const text = readExample('os-upgrade.flow.yaml');
    const out = run(text, (f) =>
      setIn(f, ['layout', '01JB7AG3BCKKDJWBHP1G201CYF'], { x: 10, y: 20 }),
    );
    expect(out.startsWith(text)).toBe(true);
    expect(out.slice(text.length)).toBe(
      'layout:\n  01JB7AG3BCKKDJWBHP1G201CYF:\n    x: 10\n    y: 20\n',
    );
  });

  it('inserts before a given key, also when that key shares a `- ` line', () => {
    const out = run('- id: 1\n  z: 9\n', (f) => setIn(f, [0, 'k'], 5, { before: ['z'] }));
    expect(out).toBe('- id: 1\n  k: 5\n  z: 9\n');
    const first = run('- id: 1\n  z: 9\n', (f) => setIn(f, [0, 'a'], 5, { before: ['id'] }));
    expect(first).toBe('- a: 5\n  id: 1\n  z: 9\n');
  });

  it('fills an empty value and converts empty flow collections to block', () => {
    const text = yamlFixture('styles.yaml');
    expect(run(text, (f) => setIn(f, ['nothing'], 'x'))).toContain('nothing: x\n');
    const seq = run(text, (f) => insertItem(f, ['empty_seq'], 'end', { k: 'v' }));
    expect(seq).toContain('empty_seq:\n- k: v\nnothing:');
    const map = run(text, (f) => setIn(f, ['empty_map', 'k'], 1));
    expect(map).toContain('empty_map:\n  k: 1\nempty_seq: []');
  });

  it('writes into non-empty flow collections in flow style', () => {
    const text = yamlFixture('styles.yaml');
    expect(run(text, (f) => setIn(f, ['a', 'z'], 3))).toContain('a: {x: 1, y: 2, z: 3}\n');
    expect(run(text, (f) => insertItem(f, ['b'], 1, 'mid'))).toContain('b: [one, mid, two]\n');
  });

  it('edits a flow map in place: its spacing stays, edits inside it stay disjoint', () => {
    const src = 'e: { from: { node: a, port: ok }, to: {node: b} }\n';
    expect(run(src, (f) => setIn(f, ['e', 'id'], 'W', { before: ['from'] }))).toBe(
      'e: { id: W, from: { node: a, port: ok }, to: {node: b} }\n',
    );
    expect(run(src, (f) => setIn(f, ['e', 'id'], 'W'))).toBe(
      'e: { from: { node: a, port: ok }, to: {node: b}, id: W }\n',
    );
    expect(run(src, (f) => setIn(f, ['e', 'from', 'node'], 'N'))).toBe(
      'e: { from: { node: N, port: ok }, to: {node: b} }\n',
    );
    expect(run("e: {k: 'a'}\n", (f) => setIn(f, ['e', 'k'], 'b'))).toBe("e: {k: 'b'}\n");
    // A plain scalar ends at a comma inside a flow collection.
    expect(run('e: {k: a}\n', (f) => setIn(f, ['e', 'k'], 'x, y'))).toBe("e: {k: 'x, y'}\n");
    expect(run('e: {k: a}\n', (f) => setIn(f, ['e', 'm'], '{v}'))).toBe("e: {k: a, m: '{v}'}\n");
    // A map without braces in a sequence is re-rendered, so the new pair stays in it.
    expect(run('s: [a: 1]\n', (f) => setIn(f, ['s', 0, 'b'], 2))).toBe('s: [{a: 1, b: 2}]\n');
  });

  it('writes CRLF and the detected indentation in a CRLF, 4-space file', () => {
    const text = yamlFixture('crlf-indented.yaml');
    const f = parseYaml(text);
    expect(f.style).toEqual({ eol: '\r\n', indentUnit: 4, seqIndentless: false });
    const out = run(text, (g) => setIn(g, ['nodes', 1, 'settings'], { retries: 2, tags: ['a'] }));
    expect(out).toContain(
      '            over two lines\r\n        settings:\r\n            retries: 2\r\n            tags:\r\n                - a\r\nedges: []',
    );
    expect(out.replace(/\r\n/g, '')).not.toContain('\n');
  });

  it('appends at EOF and keeps the missing final newline', () => {
    const out = run(yamlFixture('no-eol.yaml'), (f) => setIn(f, ['extra'], 1));
    expect(out).toBe('k: v\nlast: no-newline\nextra: 1');
  });

  it('refuses edits that touch anchors or aliases', () => {
    const f = parseYaml(yamlFixture('anchors.yaml'));
    expect(setIn(f, ['base', 'x'], 2)).toMatchObject({ ok: false, code: 'unsupported' });
    expect(setIn(f, ['free', 'y'], 3)).toMatchObject({ ok: true });
  });
});

describe('deleteKey / removeItem', () => {
  it('removes a pair with its nested lines', () => {
    const out = run('a: 1\nm:\n  x: 1\n  y: 2\nz: 0\n', (f) => deleteKey(f, [], 'm'));
    expect(out).toBe('a: 1\nz: 0\n');
  });

  it('turns the last entry of a nested map into {} and of a sequence into []', () => {
    expect(run('m:\n  x: 1\nz: 0\n', (f) => deleteKey(f, ['m'], 'x'))).toBe('m: {}\nz: 0\n');
    expect(run('s:\n- 1\nz: 0\n', (f) => removeItem(f, ['s'], 0))).toBe('s: []\nz: 0\n');
  });

  it('removes the first key of a sequence item without losing the marker', () => {
    expect(run('- a: 1\n  b: 2\n', (f) => deleteKey(f, [0], 'a'))).toBe('- b: 2\n');
  });

  it('removes a node from the example and keeps every other byte', () => {
    const text = readExample('edge-baseline.flow.yaml');
    const out = run(text, (f) => removeItem(f, ['nodes'], 7));
    const before = parse(text);
    before.nodes.splice(7, 1);
    expect(parse(out)).toEqual(before);
    expect(text.length - out.length).toBe(
      '- id: 01JB5GQAPENECFSECZP11HYGCP\n  key: failed\n  type: end\n  title: Failed\n  outcome: failed\n'
        .length,
    );
  });
});

describe('transaction and diff', () => {
  it('composes ops and reports minimal edits against the original', () => {
    const text = readExample('edge-baseline.flow.yaml');
    const tx = new YamlTransaction(text)
      .apply((f) => setIn(f, ['layout', '01JB3E28JT97KB6CQ643DZVMXX', 'x'], 152))
      .apply((f) => setIn(f, ['nodes', 1, 'title'], 'Pre-checks v2'));
    const edits = tx.edits();
    expect(edits).toHaveLength(2);
    expect(applyEdits(text, edits)).toBe(tx.text);
    expect(edits.map((e) => e.newText)).toEqual([' v2', '52']);
  });

  it('refuses an op that would break the YAML', () => {
    const tx = new YamlTransaction('a: 1\n');
    expect(() =>
      tx.apply(() => ({ ok: true, edits: [{ start: 0, end: 0, newText: ': : [' }] })),
    ).toThrow(/break/);
  });

  it('diffEdits handles insertions, deletions and identical texts', () => {
    expect(diffEdits('a\nb\n', 'a\nb\n')).toEqual([]);
    const cases = [
      ['a\nb\nc\n', 'a\nc\n'],
      ['a\nc\n', 'a\nb\nc\n'],
      ['x\n', 'y\n'],
      ['', 'new\n'],
      ['a\r\nb\r\n', 'a\r\nB\r\nb\r\n'],
    ] as const;
    for (const [a, b] of cases) expect(applyEdits(a, diffEdits(a, b))).toBe(b);
  });
});

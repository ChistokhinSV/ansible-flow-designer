// Seeded property test of the YAML edit engine. For random ops on real and style-heavy documents:
// the result parses, its data equals the expected data, edits stay inside the target collection,
// and inserting then removing restores the original bytes exactly.
// AFD_FUZZ_STEPS raises the step count (default 200 per document).
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { isMap, isSeq, type Node, parse } from 'yaml';
import {
  applyEdits,
  deleteKey,
  insertItem,
  lineStart,
  locate,
  type OpResult,
  type Path,
  parseYaml,
  removeItem,
  setIn,
  type YamlValue,
} from '../../../src/core/yaml';
import { EXAMPLES_DIR } from './helpers';

const STEPS = Number(process.env.AFD_FUZZ_STEPS ?? 200);
const YAML_DIR = join(__dirname, '../../fixtures/yaml');

const inputs = [
  ...readdirSync(EXAMPLES_DIR)
    .filter((f) => f.endsWith('.flow.yaml'))
    .map((f) => ({ name: f, text: readFileSync(join(EXAMPLES_DIR, f), 'utf8') })),
  ...readdirSync(YAML_DIR).map((f) => ({ name: f, text: readFileSync(join(YAML_DIR, f), 'utf8') })),
];

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const STRINGS = [
  'plain',
  'true',
  'no',
  'y',
  '[x]',
  "it's",
  'a: b',
  'x #y',
  '',
  ' lead',
  'multi\nline',
  '01JC5Z8V2B3N4M5P6Q7R8S9T0V',
  '1.5',
  '0x1F',
  '2026-10-28',
  'OS · ü',
  '{{ var }}',
  '- dash',
  'null',
  '~',
  '@at',
];
const KEYS = ['k', 'true', '01', 'a b', 'x', 'node_1', 'yes', 'ключ'];

type Rng = () => number;
const pick = <T>(rng: Rng, xs: readonly T[]): T => xs[Math.floor(rng() * xs.length)] as T;

function randomScalar(rng: Rng): YamlValue {
  const r = rng();
  if (r < 0.55) return pick(rng, STRINGS);
  if (r < 0.75) return Math.floor(rng() * 2000) - 500;
  if (r < 0.85) return rng() < 0.5;
  if (r < 0.9) return null;
  return Math.round(rng() * 1000) / 8;
}

function randomValue(rng: Rng, depth = 0): YamlValue {
  const r = rng();
  if (depth > 1 || r < 0.6) return randomScalar(rng);
  if (r < 0.68) return rng() < 0.5 ? [] : {};
  if (r < 0.84) {
    const n = 1 + Math.floor(rng() * 3);
    return Array.from({ length: n }, () => randomValue(rng, depth + 1));
  }
  const obj: Record<string, YamlValue> = {};
  const n = 1 + Math.floor(rng() * 3);
  for (let i = 0; i < n; i++) obj[`${pick(rng, KEYS)}${i}`] = randomValue(rng, depth + 1);
  return obj;
}

interface Target {
  path: (string | number)[];
  kind: 'map' | 'seq' | 'other';
}

function targets(value: unknown, path: (string | number)[] = [], out: Target[] = []): Target[] {
  if (Array.isArray(value)) {
    out.push({ path, kind: 'seq' });
    value.forEach((v, i) => {
      targets(v, [...path, i], out);
    });
  } else if (value !== null && typeof value === 'object') {
    out.push({ path, kind: 'map' });
    for (const [k, v] of Object.entries(value)) targets(v, [...path, k], out);
  } else {
    out.push({ path, kind: 'other' });
  }
  return out;
}

function getIn(root: unknown, path: Path): unknown {
  return path.reduce<unknown>((v, k) => (v as Record<string | number, unknown>)?.[k], root);
}

function clone<T>(v: T): T {
  return structuredClone(v);
}

interface Step {
  name: string;
  path: Path;
  op: (f: ReturnType<typeof parseYaml>) => OpResult;
  expect: (data: unknown) => unknown;
  /** Op that should restore the original bytes (insert → remove). */
  inverse?: (f: ReturnType<typeof parseYaml>) => OpResult;
}

function chooseStep(rng: Rng, data: unknown): Step | undefined {
  const all = targets(data);
  const kind = rng();
  if (kind < 0.35) {
    const t = pick(
      rng,
      all.filter((x) => x.path.length > 0),
    );
    if (!t) return undefined;
    const value = randomValue(rng);
    return {
      name: `set ${t.path.join('.')}`,
      path: t.path.slice(0, -1),
      op: (f) => setIn(f, t.path, value),
      expect: (d) => {
        const c = clone(d);
        const parent = getIn(c, t.path.slice(0, -1)) as Record<string | number, unknown>;
        parent[t.path.at(-1) as string | number] = value;
        return c;
      },
    };
  }
  const maps = all.filter((x) => x.kind === 'map');
  const seqs = all.filter((x) => x.kind === 'seq');
  if (kind < 0.55 && maps.length > 0) {
    const t = pick(rng, maps);
    const existing = getIn(data, t.path) as Record<string, unknown>;
    const key = `${pick(rng, KEYS)}_${Math.floor(rng() * 99)}`;
    if (key in existing) return undefined;
    const value = randomValue(rng);
    const blockNonEmpty = Object.keys(existing).length > 0;
    return {
      name: `add ${t.path.join('.')}.${key}`,
      path: t.path,
      op: (f) => setIn(f, [...t.path, key], value),
      expect: (d) => {
        const c = clone(d);
        (getIn(c, t.path) as Record<string, unknown>)[key] = value;
        return c;
      },
      inverse: blockNonEmpty ? (f) => deleteKey(f, t.path, key) : undefined,
    };
  }
  if (kind < 0.7 && maps.length > 0) {
    const t = pick(rng, maps);
    const keys = Object.keys(getIn(data, t.path) as object);
    if (keys.length === 0) return undefined;
    const key = pick(rng, keys);
    return {
      name: `delete ${t.path.join('.')}.${key}`,
      path: t.path,
      op: (f) => deleteKey(f, t.path, key),
      expect: (d) => {
        const c = clone(d);
        delete (getIn(c, t.path) as Record<string, unknown>)[key];
        return c;
      },
    };
  }
  if (kind < 0.88 && seqs.length > 0) {
    const t = pick(rng, seqs);
    const len = (getIn(data, t.path) as unknown[]).length;
    const index = Math.floor(rng() * (len + 1));
    const value = randomValue(rng);
    return {
      name: `insert ${t.path.join('.')}[${index}]`,
      path: t.path,
      op: (f) => insertItem(f, t.path, index, value),
      expect: (d) => {
        const c = clone(d);
        (getIn(c, t.path) as unknown[]).splice(index, 0, value);
        return c;
      },
      inverse: len > 0 ? (f) => removeItem(f, t.path, index) : undefined,
    };
  }
  if (seqs.length > 0) {
    const t = pick(rng, seqs);
    const len = (getIn(data, t.path) as unknown[]).length;
    if (len === 0) return undefined;
    const index = Math.floor(rng() * len);
    return {
      name: `remove ${t.path.join('.')}[${index}]`,
      path: t.path,
      op: (f) => removeItem(f, t.path, index),
      expect: (d) => {
        const c = clone(d);
        (getIn(c, t.path) as unknown[]).splice(index, 1);
        return c;
      },
    };
  }
  return undefined;
}

/**
 * Region an op on the collection at `path` may touch: the collection that holds it, since
 * emptying or filling a collection rewrites its own key line (`k: {}` / `k:` + block).
 */
function targetSpan(file: ReturnType<typeof parseYaml>, path: Path): [number, number] {
  if (path.length === 0) return [0, file.text.length];
  const loc = locate(file, path.slice(0, -1));
  const node = loc?.node as Node | null | undefined;
  if (!node?.range || !(isMap(node) || isSeq(node)) || path.length === 0)
    return [0, file.text.length];
  return [lineStart(file.text, node.range[0]), node.range[2]];
}

describe('YAML edit engine fuzz', () => {
  it.each(inputs)(
    '$name',
    ({ name, text }) => {
      const rng = mulberry32(name.length * 7919 + 17);
      let current = text;
      let applied = 0;
      for (let i = 0; i < STEPS; i++) {
        if (i % 25 === 0) current = text;
        const file = parseYaml(current);
        const data = file.doc.toJS();
        const step = chooseStep(rng, data);
        if (!step) continue;
        const res = step.op(file);
        if (!res.ok) {
          expect(res.code, `${name} step ${i} ${step.name}: ${res.reason}`).toBe('unsupported');
          continue;
        }
        const [lo, hi] = targetSpan(file, step.path);
        for (const e of res.edits) {
          expect(
            e.start >= lo && e.end <= hi,
            `${name} step ${i} ${step.name}: edit outside target`,
          ).toBe(true);
        }
        const next = applyEdits(current, res.edits);
        const reparsed = parseYaml(next);
        const where = `${name} step ${i} ${step.name}\n--- before\n${current}\n--- after\n${next}`;
        expect(reparsed.errors, where).toEqual([]);
        expect(parse(next), where).toEqual(step.expect(data));
        if (step.inverse) {
          const back = step.inverse(reparsed);
          expect(back.ok, `${name} step ${i} inverse of ${step.name}`).toBe(true);
          if (back.ok) {
            expect(applyEdits(next, back.edits), `${name} step ${i} inverse of ${step.name}`).toBe(
              current,
            );
          }
        }
        current = next;
        applied++;
      }
      expect(applied).toBeGreaterThan(STEPS / 3);
    },
    120_000,
  );
});

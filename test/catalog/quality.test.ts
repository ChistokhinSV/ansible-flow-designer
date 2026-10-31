// Catalog search gates (AFD-8 acceptance 1 and 2) on a full environment dump. Opt-in: set
// AFD_CATALOG_DIR to a folder of the probe's collection files (e.g. a dump of ps-probe-env:2.19,
// `just test-catalog`). Reports the module-only subset separately.
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import type { CollectionFile } from '../../src/core/catalog/types';
import { CatalogIndex } from '../../src/node/catalog/catalogIndex';

const dir = process.env.AFD_CATALOG_DIR ?? '';
const spec = parse(
  readFileSync(resolve(__dirname, '../fixtures/catalog/intent-queries.yaml'), 'utf8'),
) as {
  context: { collections: string[] };
  gates: { p95_ms: number; all_expected_in_top5: number };
  queries: { q: string; expect: string[] }[];
  resolve: { name: string; fqcn: string }[];
};

function build(): { index: CatalogIndex; buildMs: number } {
  // The parsed files go out of scope here: a 100 MB heap of them would put GC pauses into timings.
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')) as CollectionFile);
  const t0 = performance.now();
  const index = CatalogIndex.build(':memory:', files);
  return { index, buildMs: performance.now() - t0 };
}

describe.skipIf(!dir)('catalog search on a full environment', () => {
  const { index, buildMs } = dir ? build() : ({ index: undefined, buildMs: 0 } as never);

  it('ranks the expected plugins in the top 5 for 19 of 20 intents, p95 under 50 ms', () => {
    const ctx = { collections: spec.context.collections };
    // p95 over three passes after a warm-up one (statement caches, as in a running extension host).
    const times: number[] = [];
    for (let pass = 0; pass < 4; pass++) {
      for (const { q } of spec.queries) {
        const s = performance.now();
        index.search(q, ctx, 5);
        if (pass > 0) times.push(performance.now() - s);
      }
    }
    const misses: string[] = [];
    let hit = 0;
    let modulesHit = 0;
    let modules = 0;
    for (const { q, expect: want } of spec.queries) {
      const top = index.search(q, ctx, 5).map((h) => h.fqcn);
      const ok = want.every((w) => top.includes(w));
      if (ok) hit++;
      else misses.push(`${q}: want ${want.join(', ')}; got ${top.join(', ')}`);
      const mods = want.filter(
        (w) =>
          w.split('.').length === 3 &&
          !['ipaddr', 'default', 'json_query'].includes(w.split('.')[2] ?? ''),
      );
      if (mods.length === want.length) {
        modules++;
        const topModules = index.search(q, { ...ctx, types: ['module'] }, 5).map((h) => h.fqcn);
        if (mods.every((m) => topModules.includes(m))) modulesHit++;
      }
    }
    times.sort((a, b) => a - b);
    const p95 = times[Math.floor(times.length * 0.95)] ?? 0;
    console.log(
      `[catalog] ${JSON.stringify({ ...index.stats(), buildMs: Math.round(buildMs), p95Ms: Math.round(p95 * 10) / 10, hit, of: spec.queries.length, moduleQueriesHit: modulesHit, moduleQueries: modules })}`,
    );
    for (const m of misses) console.log(`[catalog] miss ${m}`);
    expect(hit).toBeGreaterThanOrEqual(spec.gates.all_expected_in_top5);
    expect(p95).toBeLessThan(spec.gates.p95_ms);
  });

  it('resolves short, legacy and redirected names', () => {
    for (const { name, fqcn } of spec.resolve) {
      expect(index.resolve(name).fqcn, name).toBe(fqcn);
    }
    expect(index.resolve('community.general.docker_image_facts').removed).toBeTruthy();
  });
});

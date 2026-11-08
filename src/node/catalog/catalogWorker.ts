// Builds a catalog index off the extension host thread (node:sqlite is synchronous and a full
// environment takes seconds). Bundled as dist/catalogWorker.js; one build per worker.
import { readFileSync, renameSync, rmSync } from 'node:fs';
import { parentPort, workerData } from 'node:worker_threads';
import { collectionFile } from '../../core/catalog/shape';
import type { CollectionFile } from '../../core/catalog/types';
import { CatalogIndex } from './catalogIndex';

export interface BuildJob {
  /** Collection files on this machine. */
  files: string[];
  /** The index to write; built beside it and renamed into place. */
  out: string;
}

export type BuildResult =
  | {
      ok: true;
      plugins: number;
      modules: number;
      collections: number;
      ms: number;
      skipped: string[];
    }
  | { ok: false; error: string };

function build(job: BuildJob): BuildResult {
  const started = performance.now();
  const tmp = `${job.out}.tmp`;
  rmSync(tmp, { force: true });
  const files: CollectionFile[] = [];
  const skipped: string[] = [];
  for (const path of job.files) {
    try {
      // AFD-163: JSON that is not a collection dump is skipped too; it threw in build.
      const file = collectionFile(JSON.parse(readFileSync(path, 'utf8')));
      if (file) files.push(file);
      else skipped.push(path);
    } catch {
      // A truncated or foreign file costs one collection, not the catalog.
      skipped.push(path);
    }
  }
  const index = CatalogIndex.build(tmp, files);
  const stats = index.stats();
  index.close();
  renameSync(tmp, job.out);
  return { ok: true, ...stats, ms: Math.round(performance.now() - started), skipped };
}

try {
  parentPort?.postMessage(build(workerData as BuildJob));
} catch (e) {
  parentPort?.postMessage({
    ok: false,
    error: e instanceof Error ? e.message : String(e),
  } satisfies BuildResult);
}

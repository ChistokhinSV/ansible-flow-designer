// What runs leave in global storage (AFD-29): `runs/<flow>/<run>/` keeps the events of the newest
// runs only, and vars.json never outlives its run. Secret inputs never reach this folder at all.
// No vscode import: paths are plain folders, so unit tests use a temporary one.
import { readdir, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { isFileId } from '../../core/flow/ids';

/** Run folders kept per flow when `afd.runs.keep` is not set. */
export const KEEP_RUNS = 30;

async function children(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir, { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }
}

/** Removes a run's vars.json once ansible-playbook is done with it. */
export async function dropVars(runDir: string): Promise<void> {
  await rm(join(runDir, 'vars.json'), { force: true });
}

/** Keeps the newest `keep` run folders of a flow (run ids are sortable time stamps). */
export async function pruneRuns(storage: string, flowId: string, keep: number): Promise<void> {
  // A flow ID that is not a ULID never names a folder here (AFD-133): the delete below is recursive.
  if (!isFileId(flowId)) return;
  const n = Number.isInteger(keep) && keep >= 1 ? keep : KEEP_RUNS;
  const dir = join(storage, 'runs', flowId);
  const old = (await children(dir)).sort().slice(0, -n);
  for (const run of old) await rm(join(dir, run), { recursive: true, force: true });
}

/**
 * At startup, when no run is going: removes the vars.json files earlier versions left behind (they
 * held every input, secrets included) and applies the retention to every flow.
 */
export async function sweepRuns(storage: string, keep: number): Promise<void> {
  const root = join(storage, 'runs');
  for (const flow of await children(root)) {
    for (const run of await children(join(root, flow)))
      await rm(join(root, flow, run, 'vars.json'), { force: true });
    await pruneRuns(storage, flow, keep);
  }
}

/**
 * Rotates `<name>.jsonl` once it reaches `limit` bytes: it becomes `<name>.1.jsonl`, the older ones
 * move up, and only `old` of them are kept.
 */
export async function rotateLog(file: string, limit: number, old: number): Promise<void> {
  let size = 0;
  try {
    size = (await stat(file)).size;
  } catch {
    return;
  }
  if (size < limit) return;
  const nth = (n: number) => file.replace(/\.jsonl$/, `.${n}.jsonl`);
  await rm(nth(old), { force: true });
  for (let n = old - 1; n >= 1; n--) await rename(nth(n), nth(n + 1)).catch(() => undefined);
  await rename(file, nth(1));
}

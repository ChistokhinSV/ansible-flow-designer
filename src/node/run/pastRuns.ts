// AFD-245: reads and writes the runs kept of a flow (a storage folder, runs/<flow id>/<run id>):
// run.json beside the run's events. Retention is the run folders' own (afd.runs.keep).
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { flowFileId, isFileId } from '../../core/flow/ids';
import type { RunView } from '../../core/protocol';
import { type PastRun, pastRunOf } from '../../core/run/pastRuns';

const FILE = 'run.json';

/** Where the runs of a flow are kept. */
export function runsDir(storage: string, flowId: string): string {
  return join(storage, 'runs', flowFileId(flowId));
}

/** Keeps a finished run with its events. The view holds host names and results, no input values. */
export async function keepRun(runDir: string, run: RunView): Promise<void> {
  try {
    await writeFile(join(runDir, FILE), JSON.stringify(run), 'utf8');
  } catch {
    // The run is shown now all the same; it is only missing from the list later.
  }
}

async function readRun(dir: string, id: string): Promise<RunView | undefined> {
  try {
    const run = JSON.parse(await readFile(join(dir, id, FILE), 'utf8')) as RunView;
    return run && typeof run === 'object' && run.id === id ? run : undefined;
  } catch {
    return undefined;
  }
}

/** The kept runs of a flow, the newest first. */
export async function listRuns(storage: string, flowId: string): Promise<PastRun[]> {
  if (!isFileId(flowId)) return [];
  const dir = runsDir(storage, flowId);
  let ids: string[] = [];
  try {
    ids = (await readdir(dir, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
  const out: PastRun[] = [];
  for (const id of ids.sort().reverse()) {
    const run = await readRun(dir, id);
    const past = run ? pastRunOf(run) : undefined;
    if (past) out.push(past);
  }
  return out;
}

export async function loadRun(
  storage: string,
  flowId: string,
  id: string,
): Promise<RunView | undefined> {
  // The id names a folder: only the ids the list gave are read.
  if (!isFileId(flowId) || !/^[0-9A-Za-z]+$/.test(id)) return undefined;
  return readRun(runsDir(storage, flowId), id);
}

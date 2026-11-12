// AFD-245: reads and writes the runs kept of a flow (global storage, runs/<flow id>/<run id>):
// run.json beside the run's events. Retention is the run folders' own (afd.runs.keep).
import * as vscode from 'vscode';
import { flowFileId, isFileId } from '../../core/flow/ids';
import type { RunView } from '../../core/protocol';
import { type PastRun, pastRunOf } from '../../core/run/pastRuns';

const FILE = 'run.json';

function dirOf(storage: vscode.Uri, flowId: string): vscode.Uri {
  return vscode.Uri.joinPath(storage, 'runs', flowFileId(flowId));
}

/** Keeps a finished run with its events. The view holds host names and results, no input values. */
export async function keepRun(runDir: vscode.Uri, run: RunView): Promise<void> {
  try {
    await vscode.workspace.fs.writeFile(
      vscode.Uri.joinPath(runDir, FILE),
      new TextEncoder().encode(JSON.stringify(run)),
    );
  } catch {
    // The run is shown now all the same; it is only missing from the list later.
  }
}

async function readRun(dir: vscode.Uri, id: string): Promise<RunView | undefined> {
  try {
    const text = new TextDecoder().decode(
      await vscode.workspace.fs.readFile(vscode.Uri.joinPath(dir, id, FILE)),
    );
    const run = JSON.parse(text) as RunView;
    return run && typeof run === 'object' && run.id === id ? run : undefined;
  } catch {
    return undefined;
  }
}

/** The kept runs of a flow, the newest first. */
export async function listRuns(storage: vscode.Uri, flowId: string): Promise<PastRun[]> {
  if (!isFileId(flowId)) return [];
  const dir = dirOf(storage, flowId);
  let ids: string[] = [];
  try {
    ids = (await vscode.workspace.fs.readDirectory(dir))
      .filter(([, type]) => type === vscode.FileType.Directory)
      .map(([name]) => name);
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
  storage: vscode.Uri,
  flowId: string,
  id: string,
): Promise<RunView | undefined> {
  // The id names a folder: only the ids the list gave are read.
  if (!isFileId(flowId) || !/^[0-9A-Za-z]+$/.test(id)) return undefined;
  return readRun(dirOf(storage, flowId), id);
}

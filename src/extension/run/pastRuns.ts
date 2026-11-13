// AFD-245: the runs kept of a flow (global storage, runs/<flow id>/<run id>). The files are
// read and written by node/run/pastRuns.ts (AFD-271); this names the storage for VS Code.
import type * as vscode from 'vscode';
import type { RunView } from '../../core/protocol';
import type { PastRun } from '../../core/run/pastRuns';
import * as kept from '../../node/run/pastRuns';

/** The kept runs of a flow, the newest first. */
export function listRuns(storage: vscode.Uri, flowId: string): Promise<PastRun[]> {
  return kept.listRuns(storage.fsPath, flowId);
}

export function loadRun(
  storage: vscode.Uri,
  flowId: string,
  id: string,
): Promise<RunView | undefined> {
  return kept.loadRun(storage.fsPath, flowId, id);
}

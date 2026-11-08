// Local run history in global storage (decision M8-2): one JSON file per flow id with the last 20
// real runs started from VS Code (local and AWX). Timings only: no hosts, inputs or output.
import * as vscode from 'vscode';
import { flowFileId } from '../../core/flow/ids';
import { appendEntry, type HistoryEntry, historyEntry } from '../../core/lens/history';
import type { RunView } from '../../core/protocol';

function fileOf(storage: vscode.Uri, flowId: string): vscode.Uri {
  return vscode.Uri.joinPath(storage, 'history', `${flowFileId(flowId)}.json`);
}

export async function readHistory(storage: vscode.Uri, flowId: string): Promise<HistoryEntry[]> {
  try {
    const data = JSON.parse(
      new TextDecoder().decode(await vscode.workspace.fs.readFile(fileOf(storage, flowId))),
    );
    return Array.isArray(data) ? (data as HistoryEntry[]) : [];
  } catch {
    return [];
  }
}

/** Records a finished real run; returns the history, or undefined when the run is not kept. */
export async function recordRun(
  storage: vscode.Uri,
  flowId: string,
  run: RunView,
): Promise<HistoryEntry[] | undefined> {
  const entry = historyEntry(run);
  if (!entry) return undefined;
  const entries = appendEntry(await readHistory(storage, flowId), entry);
  await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(storage, 'history'));
  await vscode.workspace.fs.writeFile(
    fileOf(storage, flowId),
    new TextEncoder().encode(JSON.stringify(entries)),
  );
  return entries;
}

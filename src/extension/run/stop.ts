// Runs that can be stopped (AFD-39): a local run's terminal task, or the job or workflow an AWX
// launch follows. One run per flow; `afd.running` tells the Command Palette when Stop Run applies.
import * as vscode from 'vscode';

const going = new Map<string, () => Promise<void>>();

function updateContext(): void {
  void vscode.commands.executeCommand('setContext', 'afd.running', going.size > 0);
}

/** Registers how to stop the run of a flow; dispose it when the run ends. */
export function runStarted(flow: vscode.Uri, stop: () => Promise<void>): vscode.Disposable {
  const key = flow.toString();
  going.set(key, stop);
  updateContext();
  return {
    dispose() {
      if (going.get(key) === stop) going.delete(key);
      updateContext();
    },
  };
}

/**
 * Stops the run of `flow`, or the only run going when no flow is named. Returns what it did, for
 * the message: `stopped`, `none` (nothing running) or `which` (several runs, none named).
 */
export async function stopRun(flow?: vscode.Uri): Promise<'stopped' | 'none' | 'which'> {
  const stop = flow
    ? going.get(flow.toString())
    : going.size === 1
      ? [...going.values()][0]
      : undefined;
  if (!stop) return going.size > 1 && !flow ? 'which' : 'none';
  await stop();
  return 'stopped';
}

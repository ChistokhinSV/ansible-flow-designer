// AFD-81: the run's own terminal. A run started while its flow's designer is open runs quietly
// (TaskRevealKind.Silent), so the canvas keeps the room; Show Terminal, the stall notice and a run
// the canvas cannot explain bring this terminal forward instead of whichever was last.
import * as vscode from 'vscode';

/** Per flow file: the terminal of its last local run. */
const terminals = new Map<string, vscode.Terminal>();

/**
 * Remembers the terminal of a run while it starts: task terminals carry the task's label in their
 * name, and a dedicated one is reused for the same task. Dispose once the run has started.
 */
export function watchRunTerminal(uri: vscode.Uri, label: string): vscode.Disposable {
  const take = (t: vscode.Terminal) => {
    if (t.name.includes(label)) terminals.set(uri.toString(), t);
  };
  for (const t of vscode.window.terminals) take(t);
  return vscode.window.onDidOpenTerminal(take);
}

/** Shows the flow's last run terminal; the terminal panel when that one was closed. */
export async function showRunTerminal(uri: vscode.Uri): Promise<void> {
  const t = terminals.get(uri.toString());
  if (t && vscode.window.terminals.includes(t)) t.show(false);
  else await vscode.commands.executeCommand('workbench.action.terminal.focus');
}

/** The name of the flow's last run terminal (tests). */
export function runTerminalName(uri: vscode.Uri): string | undefined {
  return terminals.get(uri.toString())?.name;
}

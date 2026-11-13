// How outcomes say what went wrong (AFD-37): a cancelled pick or prompt is not an error to show,
// and a missing AWX token or template comes with the command that fixes it, instead of commands
// matching words in messages.
import * as vscode from 'vscode';
import type { RunErrorCode } from '../core/protocol';
import { CMD } from './commands/ids';

/** The outcome text of a pick or prompt the user closed: never shown as an error. */
export const CANCELLED = 'Cancelled';

export const isCancelled = (error: string | undefined) => error === CANCELLED;

/** The fix for each error code: a button on the error message. */
const FIXES: Partial<Record<RunErrorCode, { label: string; command: string }>> = {
  'awx-token': { label: 'Set AWX Token', command: CMD.awxSetToken },
  'awx-template': { label: 'Set Up AWX Template', command: CMD.awxSetupTemplate },
  'awx-url': { label: 'Open Settings', command: 'workbench.action.openSettings' },
  'runner-token': { label: 'Set Server Token', command: CMD.runnerSetToken },
  'runner-url': { label: 'Open Settings', command: 'workbench.action.openSettings' },
  'runner-project': { label: 'Open Settings', command: 'workbench.action.openSettings' },
};

/** Shows an error with the button that fixes it, if any; nothing for a cancelled one. */
export async function showOutcomeError(
  message: string | undefined,
  code: RunErrorCode | undefined,
  scope?: vscode.Uri,
): Promise<void> {
  // A missing environment was shown with Set Up Ansible Environment… already (AFD-71).
  if (code === 'cancelled' || code === 'environment' || isCancelled(message)) return;
  const fix = code ? FIXES[code] : undefined;
  const pick = await vscode.window.showErrorMessage(
    message ?? 'It did not work',
    ...(fix ? [fix.label] : []),
  );
  if (!fix || pick !== fix.label) return;
  if (fix.command === 'workbench.action.openSettings')
    await vscode.commands.executeCommand(
      fix.command,
      code?.startsWith('runner') ? 'afd.runner' : 'afd.awx',
    );
  else await vscode.commands.executeCommand(fix.command, scope);
}

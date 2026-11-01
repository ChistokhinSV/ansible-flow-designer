import type { FlowCommand } from '../core/flow/commands';
import { type Ack, command, send } from './bus';
import { type Mode, useUi } from './store';

/** Sends a command and surfaces a refusal (bad key, cycle, YAML errors…) in the error toast. */
export async function run(cmd: FlowCommand): Promise<Ack> {
  const ack = await command(cmd);
  if (!ack.ok) useUi.getState().setError(ack.error ?? 'The change was refused');
  return ack;
}

/** Switches the mode; the first visit to Code compiles the code (later ones show the last scan). */
export function chooseMode(id: Mode): void {
  const ui = useUi.getState();
  ui.setMode(id);
  if (id === 'code' && ui.sync.state === 'idle') send({ type: 'sync' });
}

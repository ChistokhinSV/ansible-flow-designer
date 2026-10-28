import type { FlowCommand } from '../core/flow/commands';
import { type Ack, command } from './bus';
import { useUi } from './store';

/** Sends a command and surfaces a refusal (bad key, cycle, YAML errors…) in the error toast. */
export async function run(cmd: FlowCommand): Promise<Ack> {
  const ack = await command(cmd);
  if (!ack.ok) useUi.getState().setError(ack.error ?? 'The change was refused');
  return ack;
}

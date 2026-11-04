// AFD-81: a host's output in one node of the last run, asked of the host when its Output
// disclosure opens (the events stay on disk; a live run sends only its summary).
import type { OutputEntry } from '../core/run/events';
import { onHostMessage, send } from './bus';

type Answer = { entries?: OutputEntry[]; error?: string };

const pending = new Map<number, (a: Answer) => void>();
let next = 1;

onHostMessage((m) => {
  if (m.type !== 'runOutputReply') return;
  const done = pending.get(m.reqId);
  pending.delete(m.reqId);
  done?.({ entries: m.entries, error: m.error });
});

export function requestRunOutput(node: string, host: string): Promise<Answer> {
  const reqId = next++;
  return new Promise((resolve) => {
    pending.set(reqId, resolve);
    send({ type: 'runOutput', reqId, node, host });
  });
}

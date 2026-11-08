// Ends what a run, scenario or probe process started beyond itself (AFD-131): its container. The
// client process can be killed, but its container keeps running the playbook against the hosts.
import { execFile } from 'node:child_process';
import type { ProcessSpec } from '../../core/run/command';

/** Runs `spec.stop` when it has one. Resolves once it ended or after `timeoutMs`; never rejects. */
export function stopStarted(spec: ProcessSpec, timeoutMs = 15_000): Promise<void> {
  const stop = spec.stop;
  if (!stop) return Promise.resolve();
  return new Promise((done) => {
    try {
      execFile(stop.command, stop.args, { timeout: timeoutMs, windowsHide: true }, () => done());
    } catch {
      done();
    }
  });
}

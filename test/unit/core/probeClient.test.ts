// AFD-32: the probe answers one call at a time, so calls queue in the client. A call's timeout
// counts from when it is sent, a timeout fails only that call and restarts the probe for the rest,
// and an ansible-core below the floor is refused with a clear message.
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { coreSupported, ProbeClient } from '../../../src/node/env/probeClient';

const FAKE = join(__dirname, '../../fixtures/probe/fake-probe.mjs');
const clients: ProbeClient[] = [];
function fake(env: Record<string, string> = {}, log?: (line: string) => void): ProbeClient {
  const client = new ProbeClient(
    { command: process.execPath, args: [FAKE], env },
    '/repo',
    false,
    log,
  );
  clients.push(client);
  return client;
}
afterEach(() => {
  for (const c of clients.splice(0)) c.dispose();
});

describe('probe client (AFD-32)', () => {
  it('starts a call’s timeout when it is sent, not while it waits behind a slow one', async () => {
    const probe = fake();
    const slow = probe.call<{ slept: number }>('sleep', { ms: 600 }, 5_000);
    // Waits ~600 ms in the queue, but has only 300 ms once it is sent: it still answers.
    const quick = probe.call<{ a: number }>('echo', { a: 1 }, 300);
    expect(await slow).toEqual({ slept: 600 });
    expect(await quick).toEqual({ a: 1 });
  });

  it('fails only the call that timed out and restarts the probe for the next ones', async () => {
    const lines: string[] = [];
    const probe = fake({}, (l) => lines.push(l));
    const first = await probe.call<{ pid: number }>('pid');
    const hung = probe.call('hang', {}, 200);
    const after = probe.call<{ pid: number }>('pid', {}, 5_000);
    await expect(hung).rejects.toThrow('did not answer "hang" within 0.2 s');
    const second = await after;
    expect(second.pid).not.toBe(first.pid);
    expect(lines.some((l) => l.includes('restarting it for the next call'))).toBe(true);
    expect(lines.some((l) => l === 'probe stderr: hanging')).toBe(true);
  });

  it('refuses an ansible-core below the floor, saying what to change', async () => {
    const probe = fake({ FAKE_CORE: '2.18.3' });
    await expect(probe.call('echo')).rejects.toThrow(
      'This environment has ansible-core 2.18.3; Ansible Flow needs 2.19 or later',
    );
    expect(coreSupported('2.19.0')).toBe(true);
    expect(coreSupported('2.21.0rc1')).toBe(true);
    expect(coreSupported('3.0.0')).toBe(true);
    expect(coreSupported('2.18.9')).toBe(false);
  });

  it('fails every waiting call when it is stopped', async () => {
    const probe = fake();
    const running = probe.call('sleep', { ms: 1_000 }, 5_000);
    const queued = probe.call('echo', {}, 5_000);
    await new Promise((r) => setTimeout(r, 100));
    probe.dispose();
    await expect(running).rejects.toThrow('stopped');
    await expect(queued).rejects.toThrow('stopped');
  });
});

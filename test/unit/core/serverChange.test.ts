// AFD-284: what the designer says when its flow changed on Ansible Flow Server's branch, and the
// client following a project's event stream (with a reconnect after a dropped connection).
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import type { FlowDocument } from '../../../src/core/flow/types';
import { namesText, serverChangeOf } from '../../../src/core/view/serverChange';
import { type ProjectEvent, RunnerClient } from '../../../src/node/runner/client';
import { readExample } from './helpers';

const EDGE = readExample('edge-baseline.flow.yaml');
const C = 'c'.repeat(40);

describe('serverChangeOf (AFD-284)', () => {
  it('says who changed the flow and how much, or that it is gone', () => {
    const here = parse(EDGE) as FlowDocument;
    const there = parse(EDGE.replace('  title: Validate\n', '  title: Check it\n')) as FlowDocument;
    const file = 'flows/edge-baseline.flow.yaml';
    expect(
      serverChangeOf(C, [{ file, change: 'changed', authors: ['Mia Ortega'] }], file, here, there),
    ).toEqual({ commit: C, text: 'Mia Ortega changed this flow on the server: 1 step.' });
    expect(
      serverChangeOf(C, [{ file, change: 'removed', authors: ['Omar Haddad'] }], file),
    ).toEqual({ commit: C, removed: true, text: 'Omar Haddad removed this flow on the server.' });
    // Other flows changed: nothing to say here.
    expect(
      serverChangeOf(C, [{ file: 'flows/other.flow.yaml', change: 'changed', authors: [] }], file),
    ).toBeUndefined();
    expect(namesText(['A', 'B', 'C', 'D'])).toBe('A, B and 2 more');
    expect(namesText([])).toBe('Someone');
  });
});

describe('RunnerClient.follow (AFD-284)', () => {
  let server: Server;
  let base = '';
  let connections = 0;
  const auth: string[] = [];
  beforeAll(async () => {
    server = createServer((req, res) => {
      auth.push(String(req.headers.authorization));
      connections++;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      // The first connection drops after one move; the second stays.
      res.write(`event: commit\ndata: ${JSON.stringify({ commit: 'a'.repeat(40) })}\n\n`);
      if (connections === 1) {
        res.write(
          `event: moved\ndata: ${JSON.stringify({ from: 'a'.repeat(40), to: 'b'.repeat(40) })}\n\n`,
        );
        res.end();
      } else res.write(': still here\n\n');
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  it('gets where the branch is and each move, and comes back after a drop', async () => {
    const events: ProjectEvent[] = [];
    const client = new RunnerClient(base, 'afs_test-token');
    const stop = client.follow('p1', (e) => events.push(e));
    try {
      await expect
        .poll(() => events.length, { timeout: 15_000, interval: 100 })
        .toBeGreaterThanOrEqual(3);
    } finally {
      stop();
    }
    expect(events.slice(0, 3)).toEqual([
      { type: 'commit', commit: 'a'.repeat(40) },
      { type: 'moved', from: 'a'.repeat(40), to: 'b'.repeat(40) },
      { type: 'commit', commit: 'a'.repeat(40) },
    ]);
    expect(auth[0]).toBe('Bearer afs_test-token');
  }, 20_000);
});

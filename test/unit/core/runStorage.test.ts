// AFD-29: what runs leave in global storage, and the AWX token pinned to the configured AWX.
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AwxClient, FOLLOW_HOURS, followLimit } from '../../../src/node/awx/client';
import { pruneRuns, rotateLog, sweepRuns } from '../../../src/node/run/storage';

describe('run storage', () => {
  // Flow IDs are ULIDs; anything else names no folder (AFD-133).
  const F1 = '01JBX4Y5Z6A7B8C9D0E1F2G3H4';
  const F2 = '01JBX4Y5Z6A7B8C9D0E1F2G3H5';
  const run = (root: string, flow: string, id: string) => {
    const dir = join(root, 'runs', flow, id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'events.jsonl'), '{}\n');
    writeFileSync(join(dir, 'vars.json'), '{"enable_secret": "x"}');
    return dir;
  };

  it('keeps the newest run folders of a flow and sweeps vars.json from all of them', async () => {
    const root = mkdtempSync(join(tmpdir(), 'afd-runs-'));
    try {
      for (const id of ['20261030T080000Z', '20261031T090000Z', '20261029T070000Z'])
        run(root, F1, id);
      run(root, F2, '20261031T100000Z');
      await pruneRuns(root, F1, 2);
      expect(readdirSync(join(root, 'runs', F1)).sort()).toEqual([
        '20261030T080000Z',
        '20261031T090000Z',
      ]);
      await sweepRuns(root, 1);
      expect(readdirSync(join(root, 'runs', F1))).toEqual(['20261031T090000Z']);
      for (const [flow, id] of [
        [F1, '20261031T090000Z'],
        [F2, '20261031T100000Z'],
      ] as const) {
        expect(existsSync(join(root, 'runs', flow, id, 'vars.json'))).toBe(false);
        expect(existsSync(join(root, 'runs', flow, id, 'events.jsonl'))).toBe(true);
      }
      // A bad setting falls back to the default instead of deleting everything.
      await pruneRuns(root, F1, 0);
      expect(readdirSync(join(root, 'runs', F1))).toHaveLength(1);
      // A flow ID from a hostile flow file deletes nothing (AFD-133).
      run(root, 'victim', '20261031T110000Z');
      await pruneRuns(join(root, 'runs', 'x'), '../victim', 1);
      await pruneRuns(root, '../runs/victim', 0);
      expect(readdirSync(join(root, 'runs', 'victim'))).toEqual(['20261031T110000Z']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rotates the audit log at the limit and keeps two older files', async () => {
    const root = mkdtempSync(join(tmpdir(), 'afd-audit-'));
    const file = join(root, 'audit.jsonl');
    try {
      for (const n of [1, 2, 3, 4]) {
        writeFileSync(file, `${'x'.repeat(20)}${n}\n`);
        await rotateLog(file, 10, 2);
      }
      expect(readdirSync(root).sort()).toEqual(['audit.1.jsonl', 'audit.2.jsonl']);
      writeFileSync(file, 'small\n');
      await rotateLog(file, 10, 2);
      expect(existsSync(file)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('AWX client', () => {
  let server: Server;
  let base = '';
  const seen: { url?: string; auth?: string }[] = [];

  beforeAll(async () => {
    let reset = 0;
    server = createServer((req: IncomingMessage, res) => {
      seen.push({ url: req.url, auth: req.headers.authorization });
      res.setHeader('Content-Type', 'application/json');
      // AFD-32: the first ping finds its socket closed, as a stale kept-alive one would be.
      if (req.url === '/api/v2/ping/' && reset++ === 0) {
        req.socket.destroy();
        return;
      }
      if (req.url === '/api/v2/ping/') res.end(JSON.stringify({ version: '24.6.1' }));
      // Page 1 points to another host, as a misconfigured proxy might.
      else if (req.url?.includes('page=2')) res.end(JSON.stringify({ results: [2], next: null }));
      else
        res.end(
          JSON.stringify({ results: [1], next: 'http://elsewhere.example.net/api/v2/x/?page=2' }),
        );
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => server.close());

  it('follows pages on the configured AWX only and never sends the token elsewhere', async () => {
    const awx = new AwxClient(base, 'test-token');
    expect(await awx.all<number>('/api/v2/x/')).toEqual([1, 2]);
    expect(seen.map((s) => s.url)).toEqual(['/api/v2/x/?page_size=200', '/api/v2/x/?page=2']);
    expect(seen.every((s) => s.auth === 'Bearer test-token')).toBe(true);
    await expect(awx.get('http://elsewhere.example.net/api/v2/ping/')).rejects.toThrow(
      'Not sending the AWX token to http://elsewhere.example.net',
    );
  });

  it('tries a GET once more when the socket was reset (AFD-32)', async () => {
    const awx = new AwxClient(base, 'test-token');
    expect(await awx.ping()).toEqual({ version: '24.6.1' });
    expect(seen.filter((s) => s.url === '/api/v2/ping/')).toHaveLength(2);
  });

  it('stops following when cancelled or past the follow limit', () => {
    let cancelled = false;
    const now = Date.now();
    expect(followLimit(() => cancelled, now)()).toBeUndefined();
    cancelled = true;
    expect(followLimit(() => cancelled, now)()).toBe('cancelled');
    expect(followLimit(() => false, now - FOLLOW_HOURS * 3600_000 - 1)()).toBe('timeout');
  });
});

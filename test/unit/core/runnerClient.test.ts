// AFD-276: the Ansible Flow Server client, against a mock server that answers as the designer's
// contract with the server says (contract/server-api.json, AFD-280; the server replays the same
// file against its real routes). Also: which servers the client refuses to talk to, and that the
// token goes only where it should.
import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  incompatible,
  RunnerClient,
  RunnerError,
  type RunnerMeta,
} from '../../../src/node/runner/client';

interface Exchange {
  name: string;
  request: { method: string; path: string; token?: string; body?: unknown };
  response: { status: number; body?: unknown };
  capture?: Record<string, string>;
}
const contract = JSON.parse(
  readFileSync(join(__dirname, '../../../contract/server-api.json'), 'utf8'),
) as { exchanges: Exchange[] };

// One value per placeholder, so a captured id is the same wherever the contract uses it.
const SAMPLE: Record<string, unknown> = {
  $string: 'text',
  $number: 2,
  $boolean: true,
  $uuid: '7c1e2a90-1b2c-4d5e-8f90-a1b2c3d4e5f6',
  $commit: 'a'.repeat(40),
  $time: '2026-11-13T10:00:00.000Z',
  $any: null,
};
const captured: Record<string, unknown> = {};

/** A body that matches a pattern: what the server would answer. */
function sample(pattern: unknown): unknown {
  if (typeof pattern === 'string') {
    if (pattern in SAMPLE) return SAMPLE[pattern];
    const name = /^\$\{(\w+)\}$/.exec(pattern)?.[1];
    return name ? captured[name] : pattern;
  }
  if (Array.isArray(pattern)) return pattern.map(sample);
  if (pattern && typeof pattern === 'object') {
    const p = pattern as Record<string, unknown>;
    if ('$items' in p) return [sample(p.$items)];
    if ('$contains' in p) return `… ${p.$contains} …`;
    return Object.fromEntries(Object.entries(p).map(([k, v]) => [k, sample(v)]));
  }
  return pattern;
}
const pick = (body: unknown, path: string) =>
  path.split('.').reduce<unknown>((v, k) => (v as Record<string, unknown>)?.[k], body);
const fill = (text: string) => text.replace(/\$\{(\w+)\}/g, (_, n: string) => String(captured[n]));

// The mock: each exchange's request, as the contract fills it, gets its response.
const answers = new Map<string, Exchange>();
for (const x of contract.exchanges) {
  const body = sample(x.response.body);
  for (const [as, path] of Object.entries(x.capture ?? {})) captured[as] = pick(body, path);
  answers.set(
    `${x.request.method} ${fill(x.request.path)} ${x.request.token ?? ''} ${JSON.stringify(x.request.body ?? null)}`,
    {
      ...x,
      response: { ...x.response, body },
    },
  );
}

const TOKENS: Record<string, string> = {
  omar: 'afs_omar',
  'omar-read': 'afs_omar_read',
  dana: 'afs_dana',
};
const seen: IncomingMessage[] = [];
let server: Server;
let base: string;
beforeAll(async () => {
  server = createServer((req, res) => {
    seen.push(req);
    let text = '';
    req.on('data', (c) => {
      text += c;
    });
    req.on('end', () => {
      const token = Object.entries(TOKENS).find(
        ([, t]) => req.headers.authorization === `Bearer ${t}`,
      )?.[0];
      const body = JSON.stringify(text ? JSON.parse(text) : null);
      // The contract's exchanges without a token are asked with one the mock does not know.
      const x =
        answers.get(`${req.method} ${req.url} ${token ?? ''} ${body}`) ??
        answers.get(`${req.method} ${req.url}  ${body}`);
      if (!x) return void res.writeHead(404).end('{"error":"not_found","message":"No such thing"}');
      res.writeHead(x.response.status, { 'content-type': 'application/json' });
      res.end(x.response.body === undefined ? '' : JSON.stringify(x.response.body));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const a = server.address();
  base = `http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

describe('the server client, against the contract', () => {
  const omar = () => new RunnerClient(base, TOKENS.omar as string);

  it('reads what the server is, and fits a flow it reads', async () => {
    const meta = await omar().meta();
    expect(meta).toMatchObject({ name: 'Ansible Flow Server', api: 'v1' });
    expect(incompatible(meta, meta.designer.format)).toBeUndefined();
  });

  it('finds the project, its launch configuration, what a launch would run', async () => {
    const [project] = await omar().projects('net');
    expect(project).toMatchObject({ key: 'edge', gitPath: '/git/net/edge.git' });
    const [config] = await omar().configs(project?.id as string);
    expect(config).toMatchObject({ name: 'Hello', flowFile: 'flows/hello.flow.yaml' });
    const launch = await omar().check(config?.id as string, { mode: 'check' });
    expect(launch).toMatchObject({ mode: 'check', targets: ['fw-edge-01'] });
  });

  it("says why a launch cannot run, by input, in the server's words", async () => {
    const config = captured.config as string;
    const e = await omar()
      .check(config, { inputs: { devices: '' } })
      .catch((x: unknown) => x);
    expect(e).toBeInstanceOf(RunnerError);
    expect((e as RunnerError).status).toBe(422);
    expect((e as RunnerError).problems?.[0]).toMatchObject({ field: 'devices' });
  });

  it('launches, reads the run and its approvals, stops it', async () => {
    const run = await omar().launch(captured.config as string, { mode: 'check' });
    expect(run).toMatchObject({ number: 1, state: 'queued' });
    expect(await omar().run(run.id)).toMatchObject({ state: 'queued' });
    expect(await omar().gates(run.id)).toEqual([]);
    expect(await omar().cancel(run.id)).toMatchObject({ state: 'cancelled' });
    // A run without a view yet is not an error.
    expect(await omar().view(run.id)).toBeUndefined();
  });

  it("a read-only token is refused, and the refusal is the server's", async () => {
    const e = await new RunnerClient(base, TOKENS['omar-read'] as string)
      .launch(captured.config as string, {})
      .catch((x: unknown) => x);
    expect(e).toMatchObject({ status: 403, code: 'read_only_token' });
  });

  it('a token the server does not take says to set it again', async () => {
    const e = await new RunnerClient(base, 'afs_unknown')
      .request('GET', '/api/v1/workspaces')
      .catch((x: unknown) => x);
    expect((e as Error).message).toMatch(/does not take the token/);
  });
});

describe('the server client refuses', () => {
  const meta = (extra: Partial<RunnerMeta> = {}): RunnerMeta => ({
    name: 'Ansible Flow Server',
    version: '0.1.0',
    api: 'v1',
    designer: { version: '0.85.0', format: 2, formats: [1, 2] },
    ...extra,
  });

  it("a server of another API, or that does not read the flow's format", () => {
    expect(incompatible(meta({ api: 'v2' }), 2)).toMatch(/speaks API v2/);
    expect(incompatible(meta(), 3)).toMatch(/format 3.*upgrade the server/);
    expect(incompatible(meta({ name: 'Something else' }), 2)).toMatch(/not an Ansible Flow Server/);
  });

  it('to send the token in clear to another machine, unless allowed', async () => {
    const e = await new RunnerClient('http://flows.example.net', 'afs_x')
      .meta()
      .catch((x: unknown) => x);
    expect((e as Error).message).toMatch(/Not sending the token unencrypted/);
    // To this machine, plain http is fine (a local server).
    const before = seen.length;
    await new RunnerClient(base, TOKENS.omar as string).meta();
    expect(seen.length).toBe(before + 1);
    expect(seen.at(-1)?.headers.authorization).toBe(`Bearer ${TOKENS.omar}`);
  });
});

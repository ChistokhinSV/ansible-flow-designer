// The feedback Worker (feedback/worker) against a mocked fetch: checks, YouTrack, tags, Telegram.

import { describe, expect, it } from 'vitest';
import {
  type Deps,
  type Env,
  type FetchFn,
  handle,
  MAX_BODY_BYTES,
} from '../../../feedback/worker/src/handler';

const ORIGIN = 'https://chistokhinsv.github.io';
const WORKER = 'https://afd-feedback.example.workers.dev';
const env: Env = {
  YOUTRACK_URL: 'https://tracker.example.com',
  YOUTRACK_PROJECT_ID: '0-42',
  YOUTRACK_TOKEN: 'perm-test-token',
  TELEGRAM_BOT_TOKEN: '1000:bot-test-token',
  TELEGRAM_CHAT_ID: '2000001',
  TURNSTILE_SECRET: 'turnstile-test-secret',
  ALLOWED_ORIGIN: ORIGIN,
};
const NOW = new Date('2026-11-10T09:44:37Z');

const answer = {
  source: 'prompt',
  version: '0.77.0',
  editor: 'vscode',
  rating: 4,
  uses: ['design', 'ai'],
  text: 'The canvas is clear.',
  email: 'pat.doe@example.com',
  turnstile: 'turnstile-token',
};

type Route = (url: string, init: RequestInit) => Response | Promise<Response>;
type RouteName = 'turnstile' | 'issue' | 'findTag' | 'createTag' | 'addTag' | 'telegram';

interface Call {
  url: string;
  init: RequestInit;
  body: Record<string, unknown> | undefined;
}

function reply(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function bodyOf(init: RequestInit): Record<string, unknown> | undefined {
  return typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
}

/** A fetch that answers like the real services; a route can be replaced per test. */
function services(routes: Partial<Record<RouteName, Route>> = {}) {
  const calls: Call[] = [];
  const defaults: Record<RouteName, Route> = {
    turnstile: () => reply({ success: true }),
    issue: () => reply({ idReadable: 'AF-12', $type: 'Issue' }),
    findTag: () => reply([]),
    createTag: (_url, init) => reply({ id: `6-${bodyOf(init)?.name}`, name: bodyOf(init)?.name }),
    addTag: () => reply({ id: 'added', $type: 'Tag' }),
    telegram: () => reply({ ok: true }),
  };
  const routeOf = (url: string): RouteName => {
    if (url.startsWith('https://challenges.cloudflare.com/')) return 'turnstile';
    if (url.startsWith('https://api.telegram.org/')) return 'telegram';
    if (url.startsWith(`${env.YOUTRACK_URL}/api/issues?`)) return 'issue';
    if (url.startsWith(`${env.YOUTRACK_URL}/api/tags?fields=id,name&query=`)) return 'findTag';
    if (url.startsWith(`${env.YOUTRACK_URL}/api/tags?`)) return 'createTag';
    if (/\/api\/issues\/[^/]+\/tags\?/.test(url)) return 'addTag';
    throw new Error(`unexpected fetch ${url}`);
  };
  const fetch: FetchFn = async (url, init) => {
    calls.push({ url, init, body: bodyOf(init) });
    const name = routeOf(url);
    return (routes[name] ?? defaults[name])(url, init);
  };
  const to = (name: RouteName) => calls.filter((c) => routeOf(c.url) === name);
  return { fetch, calls, to };
}

function request(body: unknown, headers: Record<string, string> = {}, method = 'POST'): Request {
  return new Request(`${WORKER}/feedback`, {
    method,
    headers: {
      Origin: ORIGIN,
      'Content-Type': 'application/json',
      'CF-Connecting-IP': '203.0.113.7',
      ...headers,
    },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

async function run(req: Request, svc = services(), extra: Partial<Deps> = {}) {
  const logs: string[] = [];
  const response = await handle(req, env, {
    fetch: svc.fetch,
    now: () => NOW,
    log: (line) => logs.push(line),
    ...extra,
  });
  const text = await response.text();
  return { response, body: text ? JSON.parse(text) : null, logs, svc };
}

function header(init: RequestInit, name: string): string | null {
  return new Headers(init.headers).get(name);
}

describe('feedback worker: checks before any call out', () => {
  it('refuses another origin or none with 403, and still sends CORS headers', async () => {
    for (const headers of [{ Origin: 'https://evil.example.net' }, { Origin: '' }]) {
      const { response, body, svc } = await run(request(answer, headers));
      expect(response.status).toBe(403);
      expect(body).toEqual({ ok: false, error: 'origin' });
      expect(response.headers.get('Access-Control-Allow-Origin')).toBe(ORIGIN);
      expect(svc.calls).toEqual([]);
    }
  });

  it('answers OPTIONS with 204 and the CORS headers of the allowed origin', async () => {
    const req = new Request(`${WORKER}/feedback`, {
      method: 'OPTIONS',
      headers: { Origin: ORIGIN, 'Access-Control-Request-Method': 'POST' },
    });
    const { response, body, svc } = await run(req);
    expect(response.status).toBe(204);
    expect(body).toBeNull();
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe(ORIGIN);
    expect(response.headers.get('Access-Control-Allow-Methods')).toBe('POST');
    expect(response.headers.get('Access-Control-Allow-Headers')).toBe('Content-Type');
    expect(svc.calls).toEqual([]);
  });

  it('gives 404 for another path and 405 for another method', async () => {
    const other = await run(new Request(`${WORKER}/other`, { method: 'POST', body: '{}' }));
    expect(other.response.status).toBe(404);
    const get = await run(new Request(`${WORKER}/feedback`, { headers: { Origin: ORIGIN } }));
    expect(get.response.status).toBe(405);
    expect(get.response.headers.get('Access-Control-Allow-Origin')).toBe(ORIGIN);
  });

  it('refuses a body over 16 KB with 413', async () => {
    const big = { ...answer, text: 'a'.repeat(MAX_BODY_BYTES) };
    const { response, body, svc } = await run(request(big));
    expect(response.status).toBe(413);
    expect(body).toEqual({ ok: false, error: 'too large' });
    expect(svc.calls).toEqual([]);
  });

  it('refuses a body that is not JSON content', async () => {
    const { response } = await run(request(answer, { 'Content-Type': 'text/plain' }));
    expect(response.status).toBe(415);
  });

  it.each([
    ['{"source":', 'invalid json'],
    ['[1,2]', 'invalid json'],
    [{ ...answer, source: 'survey' }, 'invalid source'],
    [{ ...answer, version: 'v1' }, 'invalid version'],
    [{ ...answer, version: '1.0.0-a-very-long-suffix' }, 'invalid version'],
    [{ ...answer, editor: 'emacs' }, 'invalid editor'],
    [{ ...answer, rating: 6 }, 'invalid rating'],
    [{ ...answer, rating: '4' }, 'invalid rating'],
    [{ ...answer, uses: ['design', 'golf'] }, 'invalid uses'],
    [{ ...answer, uses: 'design' }, 'invalid uses'],
    [{ ...answer, source: 'uninstall', reason: 'meh' }, 'invalid reason'],
    [{ ...answer, text: 42 }, 'invalid text'],
    [{ ...answer, email: 'not an email' }, 'invalid email'],
    [{ ...answer, turnstile: '' }, 'invalid turnstile'],
    [{ ...answer, rating: null, uses: [], text: '  ' }, 'empty'],
  ])('refuses %j with 400 %s', async (body, error) => {
    const { response, body: out, svc } = await run(request(body));
    expect(response.status).toBe(400);
    expect(out).toEqual({ ok: false, error });
    expect(svc.calls).toEqual([]);
  });

  it('refuses a failed captcha with 403 before YouTrack', async () => {
    const svc = services({
      turnstile: () => reply({ success: false, 'error-codes': ['invalid-input-response'] }),
    });
    const { response, body, logs } = await run(request(answer), svc);
    expect(response.status).toBe(403);
    expect(body).toEqual({ ok: false, error: 'captcha' });
    expect(svc.to('turnstile')[0]?.body).toEqual({
      secret: 'turnstile-test-secret',
      response: 'turnstile-token',
      remoteip: '203.0.113.7',
    });
    expect(svc.calls).toHaveLength(1);
    expect(JSON.parse(logs[0] ?? '{}')).toMatchObject({
      status: 403,
      outcome: 'captcha',
      detail: 'invalid-input-response',
    });
  });

  it('answers 429 when the rate limiter says no, keyed by the client IP', async () => {
    const keys: string[] = [];
    const limiter = {
      limit: async ({ key }: { key: string }) => {
        keys.push(key);
        return { success: false };
      },
    };
    const { response, svc } = await run(request(answer), services(), { limiter });
    expect(response.status).toBe(429);
    expect(response.headers.get('Retry-After')).toBe('60');
    expect(keys).toEqual(['203.0.113.7']);
    expect(svc.calls).toEqual([]);
  });

  it('answers 503 until the YouTrack project is set', async () => {
    const svc = services();
    const logs: string[] = [];
    const response = await handle(
      request(answer),
      { ...env, YOUTRACK_PROJECT_ID: '' },
      { fetch: svc.fetch, log: (line) => logs.push(line) },
    );
    expect(response.status).toBe(503);
    expect(svc.calls).toEqual([]);
  });
});

describe('feedback worker: saving', () => {
  it('creates the YouTrack issue with the token, the project and every answer', async () => {
    const { response, body, svc } = await run(request(answer));
    expect(response.status).toBe(200);
    expect(body).toEqual({ ok: true, id: 'AF-12' });
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe(ORIGIN);

    const [issue] = svc.to('issue');
    expect(issue?.url).toBe('https://tracker.example.com/api/issues?fields=idReadable');
    expect(issue?.init.method).toBe('POST');
    expect(header(issue?.init ?? {}, 'Authorization')).toBe('Bearer perm-test-token');
    expect(header(issue?.init ?? {}, 'Content-Type')).toBe('application/json');
    expect(issue?.body?.project).toEqual({ id: '0-42' });
    expect(issue?.body?.summary).toBe('Feedback 4/5 · vscode · 0.77.0');
    expect(issue?.body?.description).toBe(
      [
        '- **Source:** prompt',
        '- **Editor:** vscode',
        '- **Version:** 0.77.0',
        '- **Rating:** 4/5',
        '- **Uses:** design, ai',
        '- **Email:** pat.doe\\@example.com',
        '- **Received:** 2026-11-10 09:44 UTC',
        '',
        '**Answer:**',
        '',
        '> The canvas is clear.',
      ].join('\n'),
    );
  });

  it.each([
    [{ ...answer, editor: 'cursor', rating: undefined }, 'Feedback · cursor · 0.77.0'],
    [
      { ...answer, source: 'uninstall', editor: 'kiro', reason: 'missing-feature' },
      'Uninstalled: missing feature · kiro · 0.77.0',
    ],
    [{ ...answer, source: 'uninstall', editor: 'kiro' }, 'Uninstalled · kiro · 0.77.0'],
    // The page opened without parameters (GitHub's issue chooser) sends no version.
    [{ ...answer, source: 'command', version: '' }, 'Feedback 4/5 · vscode'],
    [{ ...answer, version: undefined }, 'Feedback 4/5 · vscode'],
  ])('names the issue for %j: %s', async (body, expected) => {
    const { svc } = await run(request(body));
    expect(svc.to('issue')[0]?.body?.summary).toBe(expected);
  });

  it('files an answer without a version as version unknown', async () => {
    const { response, svc } = await run(request({ ...answer, version: '' }));
    expect(response.status).toBe(200);
    expect(String(svc.to('issue')[0]?.body?.description)).toContain('- **Version:** unknown');
  });

  it('takes 4000 Cyrillic characters, which 8 KB refused', async () => {
    const { response } = await run(request({ ...answer, text: 'ж'.repeat(4000) }));
    expect(response.status).toBe(200);
  });

  it('leaves out rating and uses on an uninstall answer, and reason on an in-use one', async () => {
    const uninstall = await run(request({ ...answer, source: 'uninstall', reason: 'slow' }));
    const text = String(uninstall.svc.to('issue')[0]?.body?.description);
    expect(text).toContain('- **Reason:** slow');
    expect(text).not.toContain('Rating');
    expect(text).not.toContain('Uses');
    const inUse = await run(request({ ...answer, reason: 'slow' }));
    expect(String(inUse.svc.to('issue')[0]?.body?.description)).not.toContain('Reason');
  });

  it('cuts the text at 4000 characters instead of refusing it', async () => {
    const { response, svc } = await run(request({ ...answer, text: `  ${'x'.repeat(4100)}  ` }));
    expect(response.status).toBe(200);
    const text = String(svc.to('issue')[0]?.body?.description);
    expect(text).toContain(`> ${'x'.repeat(4000)}\n`);
    expect(text).not.toContain('x'.repeat(4001));
    expect(text).toContain('_The text was cut to 4000 characters._');
  });

  it('escapes Markdown in the answer so it cannot load images or mention people', async () => {
    const text = '![p](https://tracker.invalid/p.png) <img src=x> @admin\n\nsecond *line*';
    const { svc } = await run(request({ ...answer, text }));
    const description = String(svc.to('issue')[0]?.body?.description);
    expect(description).toContain(
      '> \\!\\[p\\](https://tracker.invalid/p.png) \\<img src=x\\> \\@admin\n>\n> second \\*line\\*',
    );
  });

  it('tags the issue feedback and the editor, creating a missing tag by name', async () => {
    const svc = services({
      findTag: (url) =>
        reply(
          url.includes('query=vscode')
            ? [
                { id: '6-1', name: 'vscode' },
                { id: '6-9', name: 'vscode-old' },
              ]
            : [],
        ),
    });
    await run(request(answer), svc);
    expect(svc.to('createTag').map((c) => c.body)).toEqual([{ name: 'feedback' }]);
    const added = svc.to('addTag');
    expect(added.map((c) => c.url)).toEqual([
      'https://tracker.example.com/api/issues/AF-12/tags?fields=id',
      'https://tracker.example.com/api/issues/AF-12/tags?fields=id',
    ]);
    expect(
      added.map((c) => c.body).sort((a, b) => String(a?.id).localeCompare(String(b?.id))),
    ).toEqual([{ id: '6-1' }, { id: '6-feedback' }]);
    for (const c of added) expect(header(c.init, 'Authorization')).toBe('Bearer perm-test-token');
  });

  it('tags an uninstall answer uninstall', async () => {
    const svc = services();
    await run(request({ ...answer, source: 'uninstall', editor: 'windsurf' }), svc);
    expect(
      svc
        .to('createTag')
        .map((c) => c.body?.name)
        .sort(),
    ).toEqual(['uninstall', 'windsurf']);
  });

  it('keeps the issue when tagging fails', async () => {
    const svc = services({ addTag: () => reply({ error: 'forbidden' }, 403) });
    const { response, body, logs } = await run(request(answer), svc);
    expect(response.status).toBe(200);
    expect(body).toEqual({ ok: true, id: 'AF-12' });
    expect(JSON.parse(logs[0] ?? '{}')).toMatchObject({ tags: 'failed', telegram: 'ok' });
  });

  it('sends Telegram the summary, the start of the text and the link, never the email', async () => {
    const long = { ...answer, text: `${'y'.repeat(299)}z and more after the cut` };
    const { svc } = await run(request(long));
    const [message] = svc.to('telegram');
    expect(message?.url).toBe('https://api.telegram.org/bot1000:bot-test-token/sendMessage');
    expect(message?.body).toEqual({
      chat_id: '2000001',
      text: `Feedback 4/5 · vscode · 0.77.0\n\n${'y'.repeat(299)}z…\n\nhttps://tracker.example.com/issue/AF-12`,
      disable_web_page_preview: true,
    });
    expect(JSON.stringify(message?.body)).not.toContain('pat.doe');
  });

  it('answers 502 when YouTrack fails, after telling Telegram the answer was lost', async () => {
    const svc = services({ issue: () => reply({ error: 'boom' }, 500) });
    const { response, body, logs } = await run(request(answer), svc);
    expect(response.status).toBe(502);
    expect(body).toEqual({ ok: false, error: 'not saved' });
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe(ORIGIN);
    const [message] = svc.to('telegram');
    expect(message?.body?.text).toBe(
      'Answer lost: YouTrack did not save it (HTTP 500).\n\nFeedback 4/5 · vscode · 0.77.0\n\nThe canvas is clear.',
    );
    expect(JSON.stringify(message?.body)).not.toContain('pat.doe');
    expect(svc.to('addTag')).toEqual([]);
    expect(JSON.parse(logs[0] ?? '{}')).toMatchObject({
      status: 502,
      outcome: 'not saved',
      detail: 'youtrack HTTP 500',
    });
  });

  it.each([
    ['an error status', () => reply({ ok: false }, 500)],
    [
      'a network error',
      () => {
        throw new TypeError('fetch failed');
      },
    ],
  ])('still answers 200 when Telegram gives %s', async (_name, telegram) => {
    const { response, body, logs } = await run(request(answer), services({ telegram }));
    expect(response.status).toBe(200);
    expect(body).toEqual({ ok: true, id: 'AF-12' });
    expect(JSON.parse(logs[0] ?? '{}').telegram).not.toBe('ok');
  });

  it('logs one line with the outcome and no text, email or token', async () => {
    const { logs } = await run(request(answer));
    expect(logs).toHaveLength(1);
    expect(JSON.parse(logs[0] ?? '{}')).toMatchObject({
      msg: 'feedback',
      method: 'POST',
      path: '/feedback',
      status: 200,
      outcome: 'saved',
      id: 'AF-12',
      source: 'prompt',
      editor: 'vscode',
      version: '0.77.0',
      tags: 'ok',
      telegram: 'ok',
    });
    for (const secret of [
      'canvas',
      'pat.doe',
      'perm-test',
      'bot-test',
      'turnstile-t',
      '203.0.113',
    ]) {
      expect(logs[0]).not.toContain(secret);
    }
  });
});

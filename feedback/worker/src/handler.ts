// The Worker's request handling, with env and fetch injected so unit tests run it in Node.
// Only standard fetch API types are used here (no Workers types), see test/unit/feedback.

import { type Answer, parseAnswer } from './answer';
import { description, summary, telegramLost, telegramSaved } from './format';
import {
  type EventStore,
  eventKey,
  eventOf,
  MAX_VISIT_BYTES,
  type PageEvent,
  parseVisit,
  RETENTION_DAYS,
  summaryText,
  utcDay,
} from './visits';

// ---- Settings -------------------------------------------------------------------------------
export const PATH = '/feedback';
/** AFD-215: the page reports that it was opened. */
export const VISIT_PATH = '/visit';
// 16 KB: 4,000 characters of Cyrillic or CJK text (2 or 3 bytes each) plus a 2,048-character
// Turnstile token must fit; 8 KB refused them.
export const MAX_BODY_BYTES = 16 * 1024;
const TURNSTILE_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
const TELEGRAM_API = 'https://api.telegram.org';
const TURNSTILE_TIMEOUT_MS = 10_000;
const YOUTRACK_TIMEOUT_MS = 15_000;
const TELEGRAM_TIMEOUT_MS = 10_000;
// ---------------------------------------------------------------------------------------------

export interface Env {
  YOUTRACK_URL: string;
  YOUTRACK_PROJECT_ID: string;
  YOUTRACK_TOKEN: string;
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_CHAT_ID: string;
  TURNSTILE_SECRET: string;
  ALLOWED_ORIGIN: string;
}

export type FetchFn = (url: string, init: RequestInit) => Promise<Response>;

/** The Workers rate-limiting binding, reduced to what is used. */
export interface Limiter {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

export interface Deps {
  fetch: FetchFn;
  limiter?: Limiter | undefined;
  /** AFD-215: the KV namespace of page opens and answers; without it nothing is counted. */
  store?: EventStore | undefined;
  now?: () => Date;
  random?: () => number;
  log?: (line: string) => void;
}

/** What the one log line per request says. Never answer text, email, IP or tokens. */
interface LogInfo {
  method: string;
  path: string;
  status?: number;
  outcome?: string;
  detail?: string;
  id?: string;
  source?: string;
  editor?: string;
  version?: string;
  tags?: string;
  telegram?: string;
  counted?: string;
}

function corsHeaders(env: Env): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': env.ALLOWED_ORIGIN,
    'Access-Control-Allow-Methods': 'POST',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

function json(env: Env, status: number, body: unknown, extra: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders(env),
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      ...extra,
    },
  });
}

/** Reads the body, giving up as soon as it is longer than max bytes (null). */
async function readCapped(request: Request, max: number): Promise<Uint8Array | null> {
  const declared = Number(request.headers.get('Content-Length'));
  if (declared > max) return null;
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function errorName(e: unknown): string {
  return e instanceof Error ? e.name : 'error';
}

/** Name and message, for calls whose URL holds no secret (Turnstile, YouTrack). */
function errorText(e: unknown): string {
  return e instanceof Error ? `${e.name}: ${e.message}`.slice(0, 120) : 'error';
}

async function verifyTurnstile(
  env: Env,
  deps: Deps,
  token: string,
  ip: string | null,
): Promise<{ ok: boolean; detail?: string }> {
  try {
    const res = await deps.fetch(TURNSTILE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        secret: env.TURNSTILE_SECRET,
        response: token,
        ...(ip ? { remoteip: ip } : {}),
      }),
      signal: AbortSignal.timeout(TURNSTILE_TIMEOUT_MS),
    });
    if (!res.ok) return { ok: false, detail: `siteverify ${res.status}` };
    const data = (await res.json()) as { success?: unknown; 'error-codes'?: unknown };
    if (data.success === true) return { ok: true };
    const codes = Array.isArray(data['error-codes']) ? data['error-codes'].join(',') : '';
    return { ok: false, detail: codes || 'not success' };
  } catch (e) {
    return { ok: false, detail: `siteverify ${errorText(e)}` };
  }
}

function youtrackHeaders(env: Env): Record<string, string> {
  return {
    Authorization: `Bearer ${env.YOUTRACK_TOKEN}`,
    Accept: 'application/json',
    'Content-Type': 'application/json',
  };
}

function youtrackBase(env: Env): string {
  return env.YOUTRACK_URL.replace(/\/+$/, '');
}

async function createIssue(
  env: Env,
  deps: Deps,
  a: Answer,
  received: Date,
): Promise<{ id: string } | { error: string }> {
  try {
    const res = await deps.fetch(`${youtrackBase(env)}/api/issues?fields=idReadable`, {
      method: 'POST',
      headers: youtrackHeaders(env),
      body: JSON.stringify({
        project: { id: env.YOUTRACK_PROJECT_ID },
        summary: summary(a),
        description: description(a, received),
      }),
      signal: AbortSignal.timeout(YOUTRACK_TIMEOUT_MS),
    });
    if (!res.ok) return { error: `HTTP ${res.status}` };
    const data = (await res.json()) as { idReadable?: unknown };
    return typeof data.idReadable === 'string' ? { id: data.idReadable } : { error: 'no id' };
  } catch (e) {
    return { error: errorText(e) };
  }
}

async function youtrackJson(env: Env, deps: Deps, path: string, body?: unknown): Promise<unknown> {
  const res = await deps.fetch(`${youtrackBase(env)}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: youtrackHeaders(env),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(YOUTRACK_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`YouTrack ${path.split('?')[0]} HTTP ${res.status}`);
  return res.json();
}

/** The ID of the tag with this name the token's user can see, if any. */
async function findTag(env: Env, deps: Deps, name: string): Promise<string | undefined> {
  const q = encodeURIComponent(name);
  const tags = await youtrackJson(env, deps, `/api/tags?fields=id,name&query=${q}&$top=100`);
  if (!Array.isArray(tags)) return undefined;
  const found = tags.find(
    (t: { id?: unknown; name?: unknown }) =>
      typeof t.name === 'string' && t.name.toLowerCase() === name.toLowerCase(),
  ) as { id?: unknown } | undefined;
  return typeof found?.id === 'string' ? found.id : undefined;
}

/**
 * Adds the tag by name: finds it, or creates it (owned by the token's user), then tags the issue.
 * The tag API takes only an existing tag's ID (YouTrack REST: POST /api/issues/{id}/tags).
 */
async function addTag(env: Env, deps: Deps, issue: string, name: string): Promise<void> {
  let id = await findTag(env, deps, name);
  if (id === undefined) {
    try {
      const created = (await youtrackJson(env, deps, '/api/tags?fields=id,name', { name })) as {
        id?: unknown;
      };
      if (typeof created.id === 'string') id = created.id;
    } catch {
      // Another request may have created it a moment ago: look once more below.
    }
    id ??= await findTag(env, deps, name);
  }
  if (id === undefined) throw new Error(`tag ${name} not found or created`);
  await youtrackJson(env, deps, `/api/issues/${encodeURIComponent(issue)}/tags?fields=id`, { id });
}

async function tagIssue(env: Env, deps: Deps, issue: string, a: Answer): Promise<string> {
  const names = [a.source === 'uninstall' ? 'uninstall' : 'feedback', a.editor];
  const results = await Promise.allSettled(names.map((n) => addTag(env, deps, issue, n)));
  return results.every((r) => r.status === 'fulfilled') ? 'ok' : 'failed';
}

async function sendTelegram(env: Env, deps: Deps, text: string): Promise<string> {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) return 'off';
  try {
    const res = await deps.fetch(`${TELEGRAM_API}/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: env.TELEGRAM_CHAT_ID,
        text,
        disable_web_page_preview: true,
      }),
      signal: AbortSignal.timeout(TELEGRAM_TIMEOUT_MS),
    });
    return res.ok ? 'ok' : `HTTP ${res.status}`;
  } catch (e) {
    // The error message could carry the request URL, which holds the bot token: name only.
    return errorName(e);
  }
}

function isJsonType(contentType: string | null): boolean {
  return (contentType ?? '').split(';')[0]?.trim().toLowerCase() === 'application/json';
}

/** Stores one event; 'ok', 'off' (no store) or the error's name. Never throws. */
async function record(deps: Deps, e: PageEvent): Promise<string> {
  if (!deps.store) return 'off';
  try {
    const at = (deps.now ?? (() => new Date()))();
    await deps.store.put(eventKey(e, at, deps.random), '', {
      expirationTtl: RETENTION_DAYS * 86_400,
    });
    return 'ok';
  } catch (e) {
    return errorName(e);
  }
}

/**
 * AFD-215: POST /visit, the page was opened. Only the occasion, the version and the editor are
 * kept; the IP only keys the rate limit. sendBeacon posts text/plain (no preflight), so any
 * content type is read as JSON.
 */
async function visit(request: Request, env: Env, deps: Deps, info: LogInfo): Promise<Response> {
  const done = (status: number, outcome: string) => {
    info.outcome = outcome;
    return status === 204
      ? new Response(null, { status, headers: corsHeaders(env) })
      : json(env, status, { ok: false, error: outcome });
  };
  if (request.headers.get('Origin') !== env.ALLOWED_ORIGIN || !env.ALLOWED_ORIGIN) {
    return done(403, 'origin');
  }
  if (deps.limiter) {
    const ip = request.headers.get('CF-Connecting-IP') ?? 'unknown';
    const { success } = await deps.limiter.limit({ key: `visit:${ip}` });
    if (!success) return done(429, 'rate limited');
  }
  const bytes = await readCapped(request, MAX_VISIT_BYTES);
  if (bytes === null) return done(413, 'too large');
  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes));
  } catch {
    return done(400, 'invalid json');
  }
  const e = parseVisit(body);
  if (!e) return done(400, 'invalid visit');
  info.source = e.source;
  info.editor = e.editor;
  info.version = e.version;
  info.counted = await record(deps, e);
  return done(204, 'counted');
}

/**
 * AFD-215: the cron trigger's daily message: the events of the UTC day before `at`, or nothing
 * on a day without any. Returns what happened, for the log line.
 */
export async function dailySummary(env: Env, deps: Deps, at: Date): Promise<string> {
  const day = utcDay(new Date(at.getTime() - 86_400_000));
  let outcome: string;
  try {
    outcome = await summarize(env, deps, day);
  } catch (e) {
    outcome = `error ${errorName(e)}`;
  }
  (deps.log ?? console.log)(JSON.stringify({ msg: 'feedback summary', day, outcome }));
  return outcome;
}

async function summarize(env: Env, deps: Deps, day: string): Promise<string> {
  if (!deps.store) return 'off';
  const events: PageEvent[] = [];
  let cursor: string | undefined;
  for (;;) {
    const page = await deps.store.list({ prefix: `${day}T`, ...(cursor ? { cursor } : {}) });
    for (const k of page.keys) {
      const e = eventOf(k.name);
      if (e) events.push(e);
    }
    if (page.list_complete || !page.cursor) break;
    cursor = page.cursor;
  }
  const text = summaryText(day, events);
  if (!text) return 'none';
  return `sent ${events.length}: telegram ${await sendTelegram(env, deps, text)}`;
}

async function post(request: Request, env: Env, deps: Deps, info: LogInfo): Promise<Response> {
  const fail = (status: number, error: string, detail?: string, extra?: Record<string, string>) => {
    info.outcome = error;
    if (detail) info.detail = detail;
    return json(env, status, { ok: false, error }, extra);
  };

  if (request.headers.get('Origin') !== env.ALLOWED_ORIGIN || !env.ALLOWED_ORIGIN) {
    return fail(403, 'origin');
  }
  const ip = request.headers.get('CF-Connecting-IP');
  if (deps.limiter) {
    const { success } = await deps.limiter.limit({ key: ip ?? 'unknown' });
    if (!success) return fail(429, 'rate limited', undefined, { 'Retry-After': '60' });
  }
  if (!env.YOUTRACK_URL || !env.YOUTRACK_PROJECT_ID || !env.YOUTRACK_TOKEN) {
    return fail(503, 'not configured', 'youtrack');
  }
  if (!env.TURNSTILE_SECRET) return fail(503, 'not configured', 'turnstile');

  const bytes = await readCapped(request, MAX_BODY_BYTES);
  if (bytes === null) return fail(413, 'too large');
  if (!isJsonType(request.headers.get('Content-Type'))) return fail(415, 'content type');

  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes));
  } catch {
    return fail(400, 'invalid json');
  }
  const parsed = parseAnswer(body);
  if (!parsed.ok) return fail(400, parsed.error);
  const a = parsed.answer;
  info.source = a.source;
  info.editor = a.editor;
  info.version = a.version;

  const captcha = await verifyTurnstile(env, deps, a.turnstile, ip);
  if (!captcha.ok) return fail(403, 'captcha', captcha.detail);

  const received = (deps.now ?? (() => new Date()))();
  const issue = await createIssue(env, deps, a, received);
  if ('error' in issue) {
    info.telegram = await sendTelegram(env, deps, telegramLost(a, issue.error));
    return fail(502, 'not saved', `youtrack ${issue.error}`);
  }

  info.id = issue.id;
  const url = `${youtrackBase(env)}/issue/${issue.id}`;
  const [tags, telegram] = await Promise.all([
    tagIssue(env, deps, issue.id, a),
    sendTelegram(env, deps, telegramSaved(a, url)),
  ]);
  info.tags = tags;
  info.telegram = telegram;
  info.counted = await record(deps, {
    kind: 'answer',
    source: a.source,
    editor: a.editor,
    version: a.version,
  });
  info.outcome = 'saved';
  return json(env, 200, { ok: true, id: issue.id });
}

async function route(request: Request, env: Env, deps: Deps, info: LogInfo): Promise<Response> {
  if (info.path !== PATH && info.path !== VISIT_PATH) {
    info.outcome = 'not found';
    return json(env, 404, { ok: false, error: 'not found' });
  }
  if (request.method === 'OPTIONS') {
    info.outcome = 'preflight';
    return new Response(null, { status: 204, headers: corsHeaders(env) });
  }
  if (request.method !== 'POST') {
    info.outcome = 'method';
    return json(env, 405, { ok: false, error: 'method' }, { Allow: 'POST, OPTIONS' });
  }
  return info.path === VISIT_PATH
    ? visit(request, env, deps, info)
    : post(request, env, deps, info);
}

/** Handles one request and writes one JSON log line with its outcome. */
export async function handle(request: Request, env: Env, deps: Deps): Promise<Response> {
  const started = Date.now();
  const info: LogInfo = { method: request.method, path: new URL(request.url).pathname };
  let response: Response;
  try {
    response = await route(request, env, deps, info);
  } catch (e) {
    info.outcome = 'error';
    info.detail = errorName(e);
    response = json(env, 500, { ok: false, error: 'error' });
  }
  info.status = response.status;
  (deps.log ?? console.log)(JSON.stringify({ msg: 'feedback', ...info, ms: Date.now() - started }));
  return response;
}

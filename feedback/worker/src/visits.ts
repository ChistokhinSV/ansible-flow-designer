// Page opens and answers (AFD-215): one KV key per event, readable as it is in the dashboard and in
// `wrangler kv key list`, and the daily summary built from those keys. Plain TypeScript: no
// Workers or Node API.

import { EDITORS, SOURCES } from './answer';

/** How long an event is kept. */
export const RETENTION_DAYS = 400;
export const MAX_VISIT_BYTES = 1024;
const VERSION_RE = /^[0-9][0-9A-Za-z.+-]{0,19}$/;

export type EventKind = 'open' | 'answer';

export interface PageEvent {
  kind: EventKind;
  source: (typeof SOURCES)[number];
  editor: (typeof EDITORS)[number];
  /** Empty when the page had no version. */
  version: string;
}

/** The KV binding, reduced to what is used (Workers' KVNamespace has these). */
export interface EventStore {
  put(key: string, value: string, options: { expirationTtl: number }): Promise<void>;
  list(options: {
    prefix: string;
    cursor?: string;
  }): Promise<{ keys: { name: string }[]; list_complete: boolean; cursor?: string }>;
}

/** The body of POST /visit: the occasion, the version and the editor; nothing else is kept. */
export function parseVisit(body: unknown): PageEvent | undefined {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return undefined;
  const b = body as Record<string, unknown>;
  const source = b.source;
  const editor = b.editor;
  const version = b.version ?? '';
  if (typeof source !== 'string' || !(SOURCES as readonly string[]).includes(source))
    return undefined;
  if (typeof editor !== 'string' || !(EDITORS as readonly string[]).includes(editor))
    return undefined;
  if (typeof version !== 'string' || (version !== '' && !VERSION_RE.test(version)))
    return undefined;
  return {
    kind: 'open',
    source: source as PageEvent['source'],
    editor: editor as PageEvent['editor'],
    version,
  };
}

/** "2026-11-10" (UTC). */
export function utcDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * "2026-11-10T09:44:37.123Z open uninstall cursor 0.77.0 k3x9q2": sorted by time, listed by day
 * with a prefix, readable without its value. The random end keeps two events of one millisecond.
 */
export function eventKey(e: PageEvent, at: Date, random: () => number = Math.random): string {
  const tail = Math.floor(random() * 36 ** 6)
    .toString(36)
    .padStart(6, '0');
  return [at.toISOString(), e.kind, e.source, e.editor, e.version || '-', tail].join(' ');
}

/** The event a key holds, or undefined for a key of another shape. */
export function eventOf(key: string): PageEvent | undefined {
  const [, kind, source, editor, version] = key.split(' ');
  if (kind !== 'open' && kind !== 'answer') return undefined;
  if (!source || !(SOURCES as readonly string[]).includes(source)) return undefined;
  if (!editor || !(EDITORS as readonly string[]).includes(editor)) return undefined;
  return {
    kind,
    source: source as PageEvent['source'],
    editor: editor as PageEvent['editor'],
    version: !version || version === '-' ? '' : version,
  };
}

/** "uninstall 2, prompt 1": counts, most first, then by name. */
function tally(values: string[]): string {
  const counts = new Map<string, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  return [...counts]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([v, n]) => `${v} ${n}`)
    .join(', ');
}

/** The daily Telegram message, or undefined for a day without events. */
export function summaryText(day: string, events: PageEvent[]): string | undefined {
  if (events.length === 0) return undefined;
  const opens = events.filter((e) => e.kind === 'open');
  const answers = events.filter((e) => e.kind === 'answer');
  const lines = [`Feedback page, ${day} (UTC)`];
  const count = (label: string, list: PageEvent[]) =>
    `${label} ${list.length}${list.length ? `: ${tally(list.map((e) => e.source))}` : ''}`;
  lines.push(count('Opened', opens), count('Answers', answers));
  const seen = opens.length ? opens : answers;
  lines.push(`Editors: ${tally(seen.map((e) => e.editor))}`);
  lines.push(`Versions: ${tally(seen.map((e) => e.version || 'unknown'))}`);
  return lines.join('\n');
}

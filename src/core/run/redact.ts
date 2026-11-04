// AFD-81: secret run inputs out of the events. The callback now records each task's output, so a
// debug of a secret, or a module that echoes it, would put the value in events.jsonl (kept in the
// extension storage, read into the designer). Every string inside each event loses the values;
// keys and structure stay, so the line stays JSON.
import type { RunSummary } from './events';

export const REDACTED = '********';

/** The text forms a secret input can take in output: strings as they are, others as JSON. */
export function secretValues(secret: Record<string, unknown>): string[] {
  const out = new Set<string>();
  for (const v of Object.values(secret)) {
    if (v === undefined || v === null || v === '') continue;
    if (typeof v === 'string') out.add(v);
    else {
      out.add(JSON.stringify(v));
      if (typeof v === 'number' || typeof v === 'boolean') out.add(String(v));
    }
  }
  // Longest first: a secret that contains another is replaced whole.
  return [...out].sort((a, b) => b.length - a.length);
}

function scrub(value: unknown, secrets: readonly string[]): unknown {
  if (typeof value === 'string') {
    let s = value;
    for (const secret of secrets) if (s.includes(secret)) s = s.split(secret).join(REDACTED);
    return s;
  }
  if (Array.isArray(value)) return value.map((v) => scrub(v, secrets));
  if (value && typeof value === 'object')
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, scrub(v, secrets)]));
  return value;
}

/** One events.jsonl line without the secret values; a line that is not JSON is dropped. */
export function redactLine(line: string, secrets: readonly string[]): string {
  if (secrets.length === 0 || !line.trim()) return line;
  try {
    return JSON.stringify(scrub(JSON.parse(line), secrets));
  } catch {
    return '';
  }
}

export function redactText(text: string, secrets: readonly string[]): string {
  if (secrets.length === 0) return text;
  return text
    .split('\n')
    .map((l) => redactLine(l, secrets))
    .join('\n');
}

/**
 * Whether the run's terminal is shown when the run ends (AFD-81). It stays out of the way while
 * the designer is open (the canvas shows the run) unless the canvas has nothing to say: the run did
 * not start, produced no events, or failed with nothing the summary explains (an inventory or
 * syntax error before the first play). Without a designer it was shown from the start.
 */
export function revealAfterRun(r: {
  designerOpen: boolean;
  stopped: boolean;
  rc: number | undefined;
  events: boolean;
  summary?: RunSummary;
}): boolean {
  if (!r.designerOpen || r.stopped) return false;
  if (r.rc === undefined || !r.events) return true;
  if (r.rc === 0) return false;
  const s = r.summary;
  const explained =
    !!s &&
    (s.failures.length > 0 ||
      Object.keys(s.outcome).length > 0 ||
      s.unreachable.length > 0 ||
      Object.keys(s.problems ?? {}).length > 0);
  return !explained;
}

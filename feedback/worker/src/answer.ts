// The feedback form's answer: parsing and validation of the POST body (contract: README.md).
// Plain TypeScript with no Workers or Node API, so it runs and type-checks in both.

export const SOURCES = ['prompt', 'command', 'uninstall'] as const;
export const EDITORS = [
  'vscode',
  'cursor',
  'kiro',
  'antigravity',
  'windsurf',
  'vscodium',
  'other',
] as const;
export const USES = ['design', 'import', 'ai', 'awx', 'runs', 'other'] as const;
export const REASONS = [
  'not-needed',
  'hard-to-use',
  'missing-feature',
  'bug',
  'slow',
  'other-tool',
  'just-trying',
  'other',
] as const;

export type Source = (typeof SOURCES)[number];
export type Editor = (typeof EDITORS)[number];
export type Use = (typeof USES)[number];
export type Reason = (typeof REASONS)[number];

export const MAX_TEXT = 4000;
const MAX_VERSION = 20;
const MAX_EMAIL = 200;
// Turnstile tokens are at most 2048 characters (Cloudflare server-side validation docs).
const MAX_TOKEN = 2048;
const VERSION_RE = /^[0-9][0-9A-Za-z.+-]*$/;
// A simple shape only; brackets, quotes and backticks are refused so the address stays plain text.
const EMAIL_RE = /^[^\s@<>()[\]"'`\\,;:]+@[^\s@<>()[\]"'`\\,;:]+\.[^\s@<>()[\]"'`\\,;:]+$/;
// Control characters other than newline and tab: removed from the answer text.
const CONTROL_RE = /[^\P{Cc}\n\t]/gu;

export interface Answer {
  source: Source;
  version: string;
  editor: Editor;
  /** In-use sources (prompt, command) only. */
  rating?: number;
  /** In-use sources only; no duplicates, in the order given. */
  uses?: Use[];
  /** Uninstall only. */
  reason?: Reason;
  /** Trimmed, at most MAX_TEXT characters; may be empty. */
  text: string;
  /** True when the text was longer than MAX_TEXT and was cut. */
  cut: boolean;
  email?: string;
  turnstile: string;
}

export type Parsed = { ok: true; answer: Answer } | { ok: false; error: string };

function isOneOf<T extends string>(list: readonly T[], value: unknown): value is T {
  return typeof value === 'string' && (list as readonly string[]).includes(value);
}

/** null and undefined both mean "not given" for the optional fields. */
function given(value: unknown): boolean {
  return value !== undefined && value !== null;
}

/** Cuts by code points, so a surrogate pair is never split. */
export function cutText(text: string, max: number): { text: string; cut: boolean } {
  const points = Array.from(text);
  return points.length > max
    ? { text: points.slice(0, max).join(''), cut: true }
    : { text, cut: false };
}

/**
 * Validates the parsed JSON body. Unknown fields are ignored, and so are rating and uses on an
 * uninstall answer and reason on an in-use answer. A wrong type or enum value is an error named
 * after the field ("invalid rating").
 */
export function parseAnswer(body: unknown): Parsed {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { ok: false, error: 'invalid json' };
  }
  const b = body as Record<string, unknown>;
  const fail = (field: string): Parsed => ({ ok: false, error: `invalid ${field}` });

  if (!isOneOf(SOURCES, b.source)) return fail('source');
  const source = b.source;
  const inUse = source !== 'uninstall';

  // The page opened without parameters (the GitHub issue chooser, a shared link) sends ""; a
  // missing version is unknown, not wrong.
  const version = given(b.version) ? b.version : '';
  if (
    typeof version !== 'string' ||
    version.length > MAX_VERSION ||
    (version !== '' && !VERSION_RE.test(version))
  ) {
    return fail('version');
  }
  if (!isOneOf(EDITORS, b.editor)) return fail('editor');

  let rating: number | undefined;
  if (given(b.rating)) {
    if (
      typeof b.rating !== 'number' ||
      !Number.isInteger(b.rating) ||
      b.rating < 1 ||
      b.rating > 5
    ) {
      return fail('rating');
    }
    rating = b.rating;
  }

  let uses: Use[] | undefined;
  if (given(b.uses)) {
    if (!Array.isArray(b.uses) || !b.uses.every((u) => isOneOf(USES, u))) return fail('uses');
    uses = [...new Set(b.uses as Use[])];
  }

  let reason: Reason | undefined;
  if (given(b.reason)) {
    if (!isOneOf(REASONS, b.reason)) return fail('reason');
    reason = b.reason;
  }

  if (given(b.text) && typeof b.text !== 'string') return fail('text');
  const raw = typeof b.text === 'string' ? b.text : '';
  const { text, cut } = cutText(
    raw.replace(/\r\n?/g, '\n').replace(CONTROL_RE, '').trim(),
    MAX_TEXT,
  );

  let email: string | undefined;
  if (given(b.email)) {
    if (typeof b.email !== 'string') return fail('email');
    const trimmed = b.email.trim();
    if (trimmed !== '') {
      if (trimmed.length > MAX_EMAIL || !EMAIL_RE.test(trimmed)) return fail('email');
      email = trimmed;
    }
  }

  if (typeof b.turnstile !== 'string' || b.turnstile === '' || b.turnstile.length > MAX_TOKEN) {
    return fail('turnstile');
  }

  const answer: Answer = {
    source,
    version,
    editor: b.editor,
    text,
    cut,
    turnstile: b.turnstile,
  };
  if (inUse && rating !== undefined) answer.rating = rating;
  if (inUse && uses !== undefined && uses.length > 0) answer.uses = uses;
  if (!inUse && reason !== undefined) answer.reason = reason;
  if (email !== undefined) answer.email = email;

  // Nothing answered at all: no issue for it.
  if (
    answer.text === '' &&
    answer.rating === undefined &&
    answer.uses === undefined &&
    answer.reason === undefined
  ) {
    return { ok: false, error: 'empty' };
  }
  return { ok: true, answer };
}

// Feedback without telemetry (AFD-200): when to ask for it, and the links that open the form. The
// extension sends nothing; it opens the form page, and the person decides what to send.

/** The form page; a forwarding point, so the form behind it can change without a release. */
export const FEEDBACK_PAGE = 'https://chistokhinsv.github.io/ansible-flow-designer/feedback/';
export const ISSUES_URL = 'https://github.com/ChistokhinSV/ansible-flow-designer/issues/new/choose';
const MARKETPLACE_REVIEW =
  'https://marketplace.visualstudio.com/items?itemName=chistokhinsv.ansible-flow-designer&ssr=false#review-details';
const OPEN_VSX = 'https://open-vsx.org/extension/chistokhinsv/ansible-flow-designer';

export type FeedbackSource = 'prompt' | 'command' | 'uninstall';
export type FeedbackEditor =
  | 'vscode'
  | 'cursor'
  | 'kiro'
  | 'antigravity'
  | 'windsurf'
  | 'vscodium'
  | 'other';
export type FeedbackAnswer = 'rate' | 'more' | 'later' | 'never';

/** What `afd.feedback` keeps in global state: dates as YYYY-MM-DD in local time. */
export interface FeedbackState {
  /** The first day the designer showed a flow with steps. */
  first?: string;
  /** Distinct days of use, newest last, at most DAYS_KEPT. */
  days?: string[];
  /** How often the notice was shown. */
  asked?: number;
  /** The day it was last shown. */
  lastAsked?: string;
  /** Don't Ask Again. */
  never?: boolean;
}

/** Use days before the first notice, and days since the first use. */
export const USE_DAYS = 3;
export const MIN_DAYS = 7;
/** After Not Now: days to wait, and new use days needed, before asking again. */
export const AGAIN_DAYS = 30;
/** The notice is shown at most this often. */
export const MAX_ASKS = 2;
const DAYS_KEPT = 10;

/** A local calendar day, YYYY-MM-DD. */
export function dayOf(date: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}`;
}

/** Whole days from `a` to `b` (YYYY-MM-DD), counted on the calendar. */
function daysBetween(a: string, b: string): number {
  const ms = Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`);
  return Number.isFinite(ms) ? Math.round(ms / 86_400_000) : 0;
}

/** The state after a day of use; the same object when the day is already counted. */
export function recordUse(state: FeedbackState, today: string): FeedbackState {
  const days = state.days ?? [];
  if (days.includes(today)) return state;
  return {
    ...state,
    first: state.first ?? today,
    days: [...days, today].slice(-DAYS_KEPT),
  };
}

/** Whether the notice may show today. */
export function shouldAsk(state: FeedbackState, today: string): boolean {
  if (state.never || (state.asked ?? 0) >= MAX_ASKS || !state.first) return false;
  const days = state.days ?? [];
  if (days.length < USE_DAYS || daysBetween(state.first, today) < MIN_DAYS) return false;
  if (!state.lastAsked) return true;
  // After Not Now: a month, and some real use since.
  const since = days.filter((d) => d > (state.lastAsked as string)).length;
  return daysBetween(state.lastAsked, today) >= AGAIN_DAYS && since >= USE_DAYS;
}

/**
 * The state after the notice was answered. Rating or writing is an answer: no more asking. Not Now
 * (or closing it) waits; Don't Ask Again ends it.
 */
export function afterAnswer(
  state: FeedbackState,
  answer: FeedbackAnswer | undefined,
  today: string,
): FeedbackState {
  const asked = { ...state, asked: (state.asked ?? 0) + 1, lastAsked: today };
  return answer === 'rate' || answer === 'more' || answer === 'never'
    ? { ...asked, never: true }
    : asked;
}

/** The editor as the form names it, from VS Code's app name and URI scheme. */
export function editorOf(app: { appName: string; uriScheme: string }): FeedbackEditor {
  const scheme = app.uriScheme.toLowerCase();
  const name = app.appName.toLowerCase();
  const is = (...words: string[]) => words.some((w) => scheme.startsWith(w) || name.includes(w));
  if (is('cursor')) return 'cursor';
  if (is('antigravity')) return 'antigravity';
  if (is('devin', 'windsurf')) return 'windsurf';
  if (is('kiro')) return 'kiro';
  if (is('vscodium') || name.includes('code - oss')) return 'vscodium';
  if (scheme.startsWith('vscode') || name.includes('visual studio code')) return 'vscode';
  return 'other';
}

/** The form page for one occasion, with the version and editor as its only parameters. */
export function feedbackUrl(p: {
  source: FeedbackSource;
  version: string;
  editor: FeedbackEditor;
}): string {
  const q = new URLSearchParams({ source: p.source, version: p.version, editor: p.editor });
  return `${FEEDBACK_PAGE}?${q.toString()}`;
}

/** Where to rate the extension: the Marketplace in VS Code, Open VSX in the editors built on it. */
export function rateUrl(editor: FeedbackEditor): string {
  return editor === 'vscode' ? MARKETPLACE_REVIEW : OPEN_VSX;
}

/**
 * AFD-263: whether an editor's `extensions.json` (the list of installed extensions, in the folder
 * they are installed in) still names this extension. An uninstall takes it off the list at once,
 * while its folder stays until the next restart; an update leaves it on, with the new version.
 * Undefined when the text is not that list: then nothing is known, and nothing is asked.
 */
export function listedAsInstalled(extensionsJson: string, id: string): boolean | undefined {
  let list: unknown;
  try {
    list = JSON.parse(extensionsJson);
  } catch {
    return undefined;
  }
  if (!Array.isArray(list)) return undefined;
  const want = id.toLowerCase();
  return list.some(
    (e) =>
      typeof (e as { identifier?: { id?: unknown } })?.identifier?.id === 'string' &&
      (e as { identifier: { id: string } }).identifier.id.toLowerCase() === want,
  );
}

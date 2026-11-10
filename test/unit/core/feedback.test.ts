// AFD-201: when the extension asks for feedback, and the links it opens.
import { describe, expect, it } from 'vitest';
import {
  afterAnswer,
  dayOf,
  editorOf,
  type FeedbackState,
  feedbackUrl,
  rateUrl,
  recordUse,
  shouldAsk,
} from '../../../src/core/feedback/feedback';

const day = (n: number) => dayOf(new Date(2026, 10, 1 + n));
/** Use on the given day offsets, from day 0. */
const used = (...offsets: number[]) =>
  offsets.reduce<FeedbackState>((s, n) => recordUse(s, day(n)), {});

describe('when to ask for feedback', () => {
  it('counts each day once and keeps the first one', () => {
    const s = used(0, 0, 1);
    expect(s).toEqual({ first: day(0), days: [day(0), day(1)] });
    expect(recordUse(s, day(1))).toBe(s);
  });

  it('asks after three days of use and a week since the first', () => {
    expect(shouldAsk(used(0, 1), day(10))).toBe(false); // two use days
    expect(shouldAsk(used(0, 1, 2), day(6))).toBe(false); // six days since the first
    expect(shouldAsk(used(0, 1, 2), day(7))).toBe(true);
    expect(shouldAsk({}, day(30))).toBe(false);
  });

  it('Not Now waits a month and three more use days; at most two asks', () => {
    const first = afterAnswer(used(0, 3, 7), 'later', day(7));
    expect(first).toMatchObject({ asked: 1, lastAsked: day(7) });
    expect(shouldAsk(first, day(8))).toBe(false);
    // A month later but no new use: still not.
    expect(shouldAsk(first, day(40))).toBe(false);
    const busy = [41, 42, 43].reduce((s, n) => recordUse(s, day(n)), first);
    expect(shouldAsk(busy, day(43))).toBe(true);
    const second = afterAnswer(busy, undefined, day(43));
    const later = [80, 81, 82].reduce((s, n) => recordUse(s, day(n)), second);
    expect(shouldAsk(later, day(82))).toBe(false); // asked twice
  });

  it('a rating, a written answer or Don’t Ask Again ends the asking', () => {
    for (const answer of ['rate', 'more', 'never'] as const)
      expect(shouldAsk(afterAnswer(used(0, 1, 2), answer, day(7)), day(90))).toBe(false);
  });
});

describe('feedback links', () => {
  it('name the editor from the app', () => {
    expect(editorOf({ appName: 'Visual Studio Code', uriScheme: 'vscode' })).toBe('vscode');
    expect(editorOf({ appName: 'Cursor', uriScheme: 'cursor' })).toBe('cursor');
    expect(editorOf({ appName: 'Devin', uriScheme: 'windsurf' })).toBe('windsurf');
    expect(editorOf({ appName: 'Kiro', uriScheme: 'kiro' })).toBe('kiro');
    expect(editorOf({ appName: 'Antigravity IDE', uriScheme: 'antigravity-ide' })).toBe(
      'antigravity',
    );
    expect(editorOf({ appName: 'VSCodium', uriScheme: 'vscodium' })).toBe('vscodium');
    expect(editorOf({ appName: 'Something', uriScheme: 'thing' })).toBe('other');
  });

  it('carry only the occasion, version and editor', () => {
    const url = new URL(feedbackUrl({ source: 'prompt', version: '0.77.0', editor: 'cursor' }));
    expect(url.origin + url.pathname).toBe(
      'https://chistokhinsv.github.io/ansible-flow-designer/feedback/',
    );
    expect(Object.fromEntries(url.searchParams)).toEqual({
      source: 'prompt',
      version: '0.77.0',
      editor: 'cursor',
    });
    expect(rateUrl('vscode')).toContain('marketplace.visualstudio.com');
    expect(rateUrl('kiro')).toContain('open-vsx.org');
  });
});

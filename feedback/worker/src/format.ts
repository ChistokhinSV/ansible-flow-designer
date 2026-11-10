// Texts built from an answer: the YouTrack summary and description, and the Telegram messages.

import { type Answer, cutText, MAX_TEXT } from './answer';

/** At most this many characters of the answer text go to Telegram. */
export const TELEGRAM_EXCERPT = 300;

/** "missing-feature" -> "missing feature" */
function label(value: string): string {
  return value.replace(/-/g, ' ');
}

/**
 * "Feedback 4/5 · vscode · 0.77.0", "Feedback · cursor · 0.77.0",
 * "Uninstalled: missing feature · kiro · 0.77.0" (or "Uninstalled · kiro · 0.77.0").
 */
export function summary(a: Answer): string {
  const head =
    a.source === 'uninstall'
      ? a.reason
        ? `Uninstalled: ${label(a.reason)}`
        : 'Uninstalled'
      : a.rating !== undefined
        ? `Feedback ${a.rating}/5`
        : 'Feedback';
  return [head, a.editor, a.version].filter(Boolean).join(' · ');
}

/**
 * Backslash-escapes the Markdown characters that could make user text into a link, an image (a
 * remote load when the issue is viewed), HTML, a mention, a heading or a table.
 */
export function escapeMarkdown(text: string): string {
  return text.replace(/[\\`*_[\]<>!#|~@]/g, '\\$&');
}

/** "2026-11-10 09:44 UTC" */
export function utc(date: Date): string {
  return `${date.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

export function description(a: Answer, received: Date): string {
  const lines = [
    `- **Source:** ${a.source}`,
    `- **Editor:** ${a.editor}`,
    `- **Version:** ${a.version || 'unknown'}`,
  ];
  if (a.rating !== undefined) lines.push(`- **Rating:** ${a.rating}/5`);
  if (a.uses) lines.push(`- **Uses:** ${a.uses.join(', ')}`);
  if (a.reason) lines.push(`- **Reason:** ${label(a.reason)}`);
  if (a.email) lines.push(`- **Email:** ${escapeMarkdown(a.email)}`);
  lines.push(`- **Received:** ${utc(received)}`, '', '**Answer:**', '');
  if (a.text === '') {
    lines.push('_No text._');
  } else {
    for (const line of escapeMarkdown(a.text).split('\n')) lines.push(line ? `> ${line}` : '>');
    if (a.cut) lines.push('', `_The text was cut to ${MAX_TEXT} characters._`);
  }
  return lines.join('\n');
}

function excerpt(text: string): string {
  const { text: start, cut } = cutText(text, TELEGRAM_EXCERPT);
  return cut ? `${start}…` : start;
}

/** Summary, then the start of the answer text, then the issue link. Never the email. */
export function telegramSaved(a: Answer, issueUrl: string): string {
  return [summary(a), excerpt(a.text), issueUrl].filter((part) => part !== '').join('\n\n');
}

/** Sent when YouTrack did not save the answer, so it is not lost silently. Never the email. */
export function telegramLost(a: Answer, why: string): string {
  return [`Answer lost: YouTrack did not save it (${why}).`, summary(a), excerpt(a.text)]
    .filter((part) => part !== '')
    .join('\n\n');
}

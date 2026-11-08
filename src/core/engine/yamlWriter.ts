// Writes generated playbooks in the hand-written Ansible style of the handoff skeleton: sequences
// indented under their key, flow-style tag lists, double quotes only where a plain scalar would not
// read back as the same string, and comments between sequence items.
import { isPlainSafe } from '../yaml/render';

export type Out = string | number | boolean | null | Out[] | OutMap | FlowList | Comment;
export interface OutMap {
  [key: string]: Out | undefined;
}

/** `[a, b]` on one line. A class, not a key: a parameter map of a binding may hold any key (AFD-130). */
export class FlowList {
  constructor(readonly $flow: (string | number)[]) {}
}

/** `# text` between sequence items. */
export class Comment {
  constructor(readonly $comment: string) {}
}

export const flow = (items: (string | number)[]): FlowList => new FlowList(items);
export const comment = (text: string): Comment => new Comment(text);

const isFlow = (v: unknown): v is FlowList => v instanceof FlowList;
const isComment = (v: unknown): v is Comment => v instanceof Comment;

/**
 * Every character some YAML reader ends a line at (PyYAML also at U+0085, U+2028 and U+2029), and
 * the controls no YAML reader accepts in a stream (AFD-130).
 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters is the point.
const BREAK_OR_CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g;

/**
 * Text for one line of generated code, with its whitespace collapsed (AFD-130): a title, path or
 * pattern from the flow can neither end a comment and start YAML of its own, nor carry a
 * character that makes Ansible refuse the file.
 */
export const oneLine = (text: string): string =>
  String(text).replaceAll(BREAK_OR_CONTROL, ' ').replaceAll(/\s+/g, ' ').trim();

/** `# text` on one line whatever the text; its spaces are kept, for indented Note lines. */
export const commentLine = (text: string): string =>
  `# ${String(text).replaceAll(BREAK_OR_CONTROL, ' ')}`.trimEnd();

// Identifiers (group names, module names, keys) are plain without asking the YAML parser; the
// parser round trip in isPlainSafe dominated generation time, so other answers are cached too.
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_./-]*$/;
const RESERVED = /^(true|false|yes|no|on|off|null)$/i;
const plainCache = new Map<string, boolean>();

function plain(s: string): boolean {
  if (IDENTIFIER.test(s)) return !RESERVED.test(s);
  let known = plainCache.get(s);
  if (known === undefined) {
    known = isPlainSafe(s);
    if (plainCache.size > 5000) plainCache.clear();
    plainCache.set(s, known);
  }
  return known;
}

/** A break or control anywhere in a string: it is never plain, and is escaped when quoted. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters is the point.
const HAS_BREAK_OR_CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;

/**
 * A double-quoted scalar. JSON escapes C0 controls but leaves DEL, the C1 controls (U+0085 among
 * them) and U+2028/U+2029 raw, which PyYAML reads as line breaks or refuses (AFD-130).
 */
function quoted(v: string): string {
  return JSON.stringify(v).replaceAll(
    /[\u007f-\u009f\u2028\u2029]/g,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
}

export function scalar(v: string | number | boolean | null): string {
  if (v === null) return 'null';
  if (typeof v !== 'string') return String(v);
  return !HAS_BREAK_OR_CONTROL.test(v) && plain(v) ? v : quoted(v);
}

function inline(v: Out): string | undefined {
  if (v === null || typeof v !== 'object') return scalar(v);
  if (isFlow(v)) return `[${v.$flow.map(scalar).join(', ')}]`;
  if (Array.isArray(v) && v.length === 0) return '[]';
  if (!Array.isArray(v) && !isComment(v) && Object.keys(v).length === 0) return '{}';
  return undefined;
}

/** Lines of a block map or sequence starting at column `col`; `first` continues a `- ` line. */
export function writeBlock(v: OutMap | Out[], col: number, first = false): string[] {
  const pad = ' '.repeat(col);
  const lines: string[] = [];
  const push = (text: string) => lines.push(first && lines.length === 0 ? text : pad + text);
  if (Array.isArray(v)) {
    for (const item of v) {
      if (isComment(item)) {
        lines.push(`${pad}${commentLine(item.$comment)}`);
        continue;
      }
      const one = inline(item);
      if (one !== undefined) {
        push(`- ${one}`);
        continue;
      }
      const inner = writeBlock(item as OutMap | Out[], col + 2, true);
      push(`- ${inner[0]}`);
      lines.push(...inner.slice(1));
    }
    return lines;
  }
  for (const [key, value] of Object.entries(v)) {
    if (value === undefined) continue;
    const one = inline(value);
    if (one !== undefined) {
      push(`${scalar(key)}: ${one}`);
      continue;
    }
    push(`${scalar(key)}:`);
    lines.push(...writeBlock(value as OutMap | Out[], col + 2));
  }
  return lines;
}

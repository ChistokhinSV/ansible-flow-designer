// Writes generated playbooks in the hand-written Ansible style of the handoff skeleton: sequences
// indented under their key, flow-style tag lists, double quotes only where a plain scalar would not
// read back as the same string, and comments between sequence items.
import { isPlainSafe } from '../yaml/render';

export type Out = string | number | boolean | null | Out[] | OutMap | FlowList | Comment;
export interface OutMap {
  [key: string]: Out | undefined;
}

/** `[a, b]` on one line. */
export interface FlowList {
  $flow: (string | number)[];
}

/** `# text` between sequence items. */
export interface Comment {
  $comment: string;
}

export const flow = (items: (string | number)[]): FlowList => ({ $flow: items });
export const comment = (text: string): Comment => ({ $comment: text });

const isFlow = (v: unknown): v is FlowList =>
  typeof v === 'object' && v !== null && '$flow' in (v as object);
const isComment = (v: unknown): v is Comment =>
  typeof v === 'object' && v !== null && '$comment' in (v as object);

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

export function scalar(v: string | number | boolean | null): string {
  if (v === null) return 'null';
  if (typeof v !== 'string') return String(v);
  return plain(v) ? v : JSON.stringify(v);
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
        lines.push(`${pad}# ${item.$comment}`);
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

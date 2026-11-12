// What the YAML box needs from its text (AFD-103, round 3: R4): tokens to colour a line, and what
// Enter inserts, as an editor would. Line by line and forgiving: a half-typed line still colours.
// No YAML library: this runs on every keystroke. AFD-224: Jinja inside values is coloured as the
// fields colour it, and the values of bare keys (when, changed_when, failed_when) as expressions.

import { COLOUR_OF, exprMode, type ScanOptions, type SyntaxColour, scanJinja } from './jinjaText';

export type YamlTokenKind = 'key' | 'string' | 'scalar' | 'comment' | 'dash' | 'punct';

export interface YamlToken {
  text: string;
  kind?: YamlTokenKind;
}

const SCALAR = /^(true|false|yes|no|null|~|-?[0-9]+(?:[.][0-9]+)?)$/i;

/**
 * Where the quoted string starting at `i` ends (past its closing quote, or the end of the line):
 * `''` inside single quotes and `\"` inside double quotes do not end it (AFD-222).
 */
export function quoteEnd(text: string, i: number): number {
  const q = text[i];
  for (let j = i + 1; j < text.length; j++) {
    const c = text[j];
    if (q === '"' && c === '\\') {
      j++;
      continue;
    }
    if (c !== q) continue;
    if (q === "'" && text[j + 1] === "'") {
      j++;
      continue;
    }
    return j + 1;
  }
  return text.length;
}

/** The value part of a line: strings, a trailing comment, and a plain scalar coloured as such. */
function valueTokens(rest: string, out: YamlToken[]): void {
  let plain = '';
  const flush = () => {
    if (!plain) return;
    const lead = plain.length - plain.trimStart().length;
    const core = plain.trim();
    const trail = plain.length - lead - core.length;
    if (lead) out.push({ text: plain.slice(0, lead) });
    if (core) out.push({ text: core, kind: SCALAR.test(core) ? 'scalar' : undefined });
    if (trail) out.push({ text: plain.slice(lead + core.length) });
    plain = '';
  };
  let i = 0;
  while (i < rest.length) {
    const c = rest[i] as string;
    if (c === '#' && (i === 0 || rest[i - 1] === ' ')) {
      flush();
      out.push({ text: rest.slice(i), kind: 'comment' });
      return;
    }
    if (c === '"' || c === "'") {
      const stop = quoteEnd(rest, i);
      flush();
      out.push({ text: rest.slice(i, stop), kind: 'string' });
      i = stop;
      continue;
    }
    plain += c;
    i++;
  }
  flush();
}

/** One line of YAML as coloured tokens; joined, they give the line back unchanged. */
export function yamlTokens(line: string): YamlToken[] {
  const out: YamlToken[] = [];
  const indent = line.length - line.trimStart().length;
  if (indent) out.push({ text: line.slice(0, indent) });
  let rest = line.slice(indent);
  if (rest.startsWith('#')) {
    out.push({ text: rest, kind: 'comment' });
    return out;
  }
  // List dashes: `- `, `- - `.
  const dash = /^(-(?: |$))+/.exec(rest);
  if (dash) {
    out.push({ text: dash[0], kind: 'dash' });
    rest = rest.slice(dash[0].length);
  }
  // A key: plain or quoted, then a colon at the end or before a space.
  const key = /^("[^"]*"|'[^']*'|[^\s#'"][^:#]*?)(:)(?= |$)/.exec(rest);
  if (key) {
    out.push({ text: key[1] as string, kind: 'key' });
    out.push({ text: ':', kind: 'punct' });
    rest = rest.slice(key[0].length);
  }
  valueTokens(rest, out);
  return out;
}

/** A piece of a line with its colour; joined, the pieces give the line back. */
export interface ColouredText {
  text: string;
  colour?: SyntaxColour | 'muted';
}

const JINJA = /\{\{|\{%|\{#/;

/** A value (inside its quotes, if any) as Jinja: template text stays `plain`'s colour. */
function jinjaPieces(
  text: string,
  bare: boolean,
  yamlQuote: "'" | '"' | undefined,
  plain: SyntaxColour | undefined,
): ColouredText[] {
  const tokens = scanJinja(text, { mode: exprMode(text, bare), yamlQuote }).tokens;
  return tokens.map((t) => {
    const colour = t.kind ? COLOUR_OF[t.kind] : t.text.trim() ? plain : undefined;
    return colour ? { text: t.text, colour } : { text: t.text };
  });
}

/** The structural tokens of a line in colours: keys, dashes, quoted strings, scalars, comments. */
function structural(line: string): ColouredText[] {
  return yamlTokens(line).map((t): ColouredText => {
    if (t.kind === 'key') return { text: t.text, colour: 'key' };
    if (t.kind === 'comment') return { text: t.text, colour: 'comment' };
    if (t.kind === 'dash' || t.kind === 'punct') return { text: t.text, colour: 'muted' };
    if (t.kind === 'string') return { text: t.text, colour: 'string' };
    if (t.kind === 'scalar')
      return { text: t.text, colour: /^-?[0-9]/.test(t.text) ? 'number' : 'constant' };
    return { text: t.text };
  });
}

/**
 * Where a line's value is (AFD-225): after its indent, dashes and key. A quoted value runs to its
 * closing quote; a plain one to a comment, without trailing spaces. An empty value is where it
 * would start, at the end of the line. None for a comment line.
 */
export function valueSpan(
  line: string,
): { start: number; end: number; quote?: "'" | '"' } | undefined {
  let i = line.length - line.trimStart().length;
  if (line.startsWith('#', i)) return undefined;
  const dash = /^(-(?: |$))+/.exec(line.slice(i));
  if (dash) i += dash[0].length;
  const key = /^("[^"]*"|'[^']*'|[^\s#'"][^:#]*?)(:)(?= |$)/.exec(line.slice(i));
  if (key) i += key[0].length;
  while (line[i] === ' ') i++;
  if (i >= line.length) return { start: line.length, end: line.length };
  const c = line[i];
  if (c === '"' || c === "'") return { start: i, end: quoteEnd(line, i), quote: c };
  const comment = /\s#/.exec(line.slice(i));
  let end = comment ? i + comment.index : line.length;
  while (end > i && line[end - 1] === ' ') end--;
  return { start: i, end };
}

/**
 * The Jinja a caret at `col` is in (AFD-225): the value's text (inside its quotes), where it
 * starts in the line, and how to scan it. Outside the value, nothing.
 */
export function yamlJinjaAt(
  line: string,
  col: number,
  bare: boolean,
): { text: string; base: number; opts: ScanOptions } | undefined {
  const v = valueSpan(line);
  if (!v) return undefined;
  if (v.quote) {
    const closed =
      v.end - v.start > 1 && line[v.end - 1] === v.quote && quoteEnd(line, v.start) === v.end;
    const innerEnd = closed ? v.end - 1 : v.end;
    if (col <= v.start || col > innerEnd) return undefined;
    const text = line.slice(v.start + 1, innerEnd);
    return { text, base: v.start + 1, opts: { mode: exprMode(text, bare), yamlQuote: v.quote } };
  }
  if (col < v.start || col > v.end) return undefined;
  const text = line.slice(v.start, v.end);
  return { text, base: v.start, opts: { mode: exprMode(text, bare) } };
}

/**
 * One line of the YAML box in colours (AFD-224): its structure as `yamlTokens` gives it, and
 * Jinja inside the value. `bare` says the value is a bare expression (it belongs to `when`,
 * `changed_when`, `failed_when`).
 */
export function yamlColours(line: string, bare = false): ColouredText[] {
  const v = valueSpan(line);
  if (!v || v.start === v.end) return structural(line);
  const out = structural(line.slice(0, v.start));
  const value = line.slice(v.start, v.end);
  if (v.quote) {
    const closed =
      value.length > 1 && quoteEnd(value, 0) === value.length && value.endsWith(v.quote);
    const inner = value.slice(1, closed ? -1 : undefined);
    if (!bare && !JINJA.test(inner)) out.push({ text: value, colour: 'string' });
    else {
      out.push({ text: v.quote, colour: 'string' });
      out.push(...jinjaPieces(inner, bare, v.quote, bare ? undefined : 'string'));
      if (closed) out.push({ text: v.quote, colour: 'string' });
    }
  } else if (bare || JINJA.test(value)) out.push(...jinjaPieces(value, bare, undefined, undefined));
  else out.push(...structural(value));
  out.push(...structural(line.slice(v.end)));
  return out;
}

/**
 * The top-level key each line belongs to (AFD-224): its own, or the one above it for an indented
 * line or a list item, so the items of `when:` are bare expressions too.
 */
export function yamlKeyContext(lines: readonly string[]): (string | undefined)[] {
  let current: string | undefined;
  return lines.map((line) => {
    const top = /^([A-Za-z_][\w-]*)\s*:(?= |$)/.exec(line);
    if (top) current = top[1];
    else if (line.trim() && !/^\s/.test(line) && !line.startsWith('-') && !line.startsWith('#'))
      current = undefined;
    return current;
  });
}

/**
 * What Enter inserts at the end of `before` (the line up to the caret), as an editor does: the
 * same indent; two more after `key:`; a new item after `- item`. On an empty `- ` the list ends:
 * `clear` says to drop the dash and step back to the list's key.
 */
export function enterText(before: string): { text: string; clear?: boolean } {
  const indent = before.length - before.trimStart().length;
  const pad = (n: number) => ' '.repeat(n);
  const item = /^(\s*)- ?(.*)$/.exec(before);
  if (item) {
    const content = (item[2] as string).trim();
    if (!content) return { text: pad(Math.max(0, indent - 2)), clear: true };
    // `- key:` opens a map inside the item; `- key: value` continues the item's map.
    const at = indent + 2;
    if (/^[^#'"\s][^#]*:$/.test(content)) return { text: `\n${pad(at + 2)}` };
    if (/^[^#'"\s][^:#]*: /.test(content)) return { text: `\n${pad(at)}` };
    return { text: `\n${pad(indent)}- ` };
  }
  const body = before.replace(/\s+#.*$/, '').trimEnd();
  if (/^\s*[^#'"\s][^#]*:$/.test(body)) return { text: `\n${pad(indent + 2)}` };
  return { text: `\n${pad(indent)}` };
}

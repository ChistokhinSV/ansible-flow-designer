// What the YAML box needs from its text (AFD-103, round 3: R4): tokens to colour a line, and what
// Enter inserts, as an editor would. Line by line and forgiving: a half-typed line still colours.
// No YAML library: this runs on every keystroke.

export type YamlTokenKind = 'key' | 'string' | 'scalar' | 'comment' | 'dash' | 'punct';

export interface YamlToken {
  text: string;
  kind?: YamlTokenKind;
}

const SCALAR = /^(true|false|yes|no|null|~|-?[0-9]+(?:[.][0-9]+)?)$/i;

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
      const end = rest.indexOf(c, i + 1);
      const stop = end < 0 ? rest.length : end + 1;
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

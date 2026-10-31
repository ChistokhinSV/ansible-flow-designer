// Jinja references in binding parameters (M5, D-26): input chips are `{{ name }}` in the stored
// text, and renaming an input rewrites every expression that reads it. A scanner, not a parser:
// enough for variable references, filters, attribute access and string literals.

export type Segment = { text: string } | { ref: string; raw: string };

/** `{{ name }}` or `{{ name.attr }}`: an expression that is only a variable reference (a chip). */
const SIMPLE = /^\{\{-?\s*([A-Za-z_][A-Za-z0-9_]*)\s*-?\}\}$/;
const EXPRESSION = /\{\{[\s\S]*?\}\}/g;

/** Text and chip segments of a parameter value; complex expressions stay text. */
export function segments(value: string): Segment[] {
  const out: Segment[] = [];
  let at = 0;
  for (const m of value.matchAll(EXPRESSION)) {
    const start = m.index ?? 0;
    const name = SIMPLE.exec(m[0])?.[1];
    if (!name) continue;
    if (start > at) out.push({ text: value.slice(at, start) });
    out.push({ ref: name, raw: m[0] });
    at = start + m[0].length;
  }
  if (at < value.length || out.length === 0) out.push({ text: value.slice(at) });
  return out;
}

export function joinSegments(parts: Segment[]): string {
  return parts.map((p) => ('ref' in p ? `{{ ${p.ref} }}` : p.text)).join('');
}

/**
 * Variables an expression body reads: identifiers outside string literals that are not attribute
 * names (`x.name`), keyword arguments (`default(x=1)`), filter or test names, or Jinja keywords.
 */
const KEYWORDS = new Set([
  'and',
  'or',
  'not',
  'in',
  'is',
  'if',
  'else',
  'true',
  'false',
  'none',
  'True',
  'False',
  'None',
]);

interface Token {
  name: string;
  start: number;
}

function identifiers(body: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  let prev = '';
  while (i < body.length) {
    const ch = body[i] ?? '';
    if (ch === "'" || ch === '"') {
      const end = body.indexOf(ch, i + 1);
      i = end < 0 ? body.length : end + 1;
      prev = 'str';
      continue;
    }
    const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(body.slice(i));
    if (m) {
      const name = m[0];
      const after = body.slice(i + name.length).trimStart();
      const kwarg = after.startsWith('=') && !after.startsWith('==');
      // lookup('…'), range(3): functions, not variables.
      const call = after.startsWith('(');
      if (prev !== '.' && prev !== '|' && prev !== 'is' && !kwarg && !call && !KEYWORDS.has(name))
        out.push({ name, start: i });
      prev = name === 'is' ? 'is' : 'id';
      i += name.length;
      continue;
    }
    if (!/\s/.test(ch)) prev = ch;
    i++;
  }
  return out;
}

/** Every variable the value's Jinja expressions read, in order of appearance. */
export function parseRefs(value: string): string[] {
  const names: string[] = [];
  for (const m of value.matchAll(EXPRESSION))
    for (const t of identifiers(m[0].slice(2, -2))) if (!names.includes(t.name)) names.push(t.name);
  return names;
}

/** The value with reads of `from` renamed to `to` (attribute names and literals untouched). */
export function renameRef(value: string, from: string, to: string): string {
  return value.replaceAll(EXPRESSION, (expr) => {
    const body = expr.slice(2, -2);
    let out = '';
    let at = 0;
    for (const t of identifiers(body)) {
      if (t.name !== from) continue;
      out += body.slice(at, t.start) + to;
      at = t.start + from.length;
    }
    return `{{${out}${body.slice(at)}}}`;
  });
}

/** Applies `fn` to every string inside a parameter tree (lists and maps of any depth). */
export function mapStrings(value: unknown, fn: (s: string) => string): unknown {
  if (typeof value === 'string') return fn(value);
  if (Array.isArray(value)) return value.map((v) => mapStrings(v, fn));
  if (value && typeof value === 'object')
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, mapStrings(v, fn)]));
  return value;
}

/** Every variable read anywhere in a parameter tree. */
export function refsIn(value: unknown): string[] {
  const names = new Set<string>();
  mapStrings(value, (s) => {
    for (const n of parseRefs(s)) names.add(n);
    return s;
  });
  return [...names];
}

/**
 * Variables read by values Ansible evaluates as bare expressions (assert `that`, decision
 * conditions, `until`): no braces needed, though a value with braces is read as a template.
 */
export function exprRefs(value: unknown): string[] {
  const names = new Set<string>();
  mapStrings(value, (s) => {
    const found = s.includes('{{') ? parseRefs(s) : identifiers(s).map((t) => t.name);
    for (const n of found) names.add(n);
    return s;
  });
  return [...names];
}

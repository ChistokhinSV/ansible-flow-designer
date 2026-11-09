// Jinja references in binding parameters (M5, D-26): input chips are `{{ name }}` in the stored
// text, and renaming an input rewrites every expression that reads it. A scanner, not a parser:
// enough for variable references, filters, attribute access and string literals.

export type Segment = { text: string } | { ref: string; raw: string };

/**
 * `{{ name }}` or `{{ name.field }}`: an expression that is only a variable reference (a chip).
 * A dotted path reads a field of a step's result (AFD-108, wave 10: Z1); before, only the bare
 * name was a chip, so `.stdout` typed after one stayed text outside the braces.
 */
const SIMPLE = /^\{\{-?\s*([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*)\s*-?\}\}$/;
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
      // AFD-182: `x is not defined`: the test name follows `not` too.
      prev = name === 'is' || (name === 'not' && prev === 'is') ? 'is' : 'id';
      i += name.length;
      continue;
    }
    if (!/\s/.test(ch)) prev = ch;
    i++;
  }
  return out;
}

/** `{{ … }}` or `{% … %}` (AFD-183: statements read and bind names too); comments are skipped. */
const TAG = /\{\{([\s\S]*?)\}\}|\{%-?([\s\S]*?)-?%\}/g;
const COMMENT = /\{#[\s\S]*?#\}/g;
const NAME = /[A-Za-z_][A-Za-z0-9_]*/g;

/**
 * What a statement body reads and binds (AFD-183): `set x = …`, `for a, b in … if …`, `with a = …`
 * and `macro m(args)` bind names the template then reads as its own; `if`, `elif`, loop sources and
 * set values are reads. Other statements (endfor, else, filter, raw) read nothing.
 */
function statement(body: string): { reads: Token[]; binds: string[] } {
  const head = /^\s*([a-z_]+)\b/.exec(body);
  if (!head) return { reads: [], binds: [] };
  const word = head[1] as string;
  const restAt = head[0].length;
  const rest = body.slice(restAt);
  const shifted = (text: string, at: number) =>
    identifiers(text).map((t) => ({ name: t.name, start: t.start + at }));
  switch (word) {
    case 'if':
    case 'elif':
    case 'do':
      return { reads: shifted(rest, restAt), binds: [] };
    case 'set': {
      // `set ns.x = …` assigns into a namespace: ns is read, not bound.
      const target = /^\s*([A-Za-z_][\w]*(?:\s*,\s*[A-Za-z_]\w*)*)\s*(?=[=]|$)/.exec(rest);
      const eq = rest.indexOf('=');
      const reads = eq < 0 ? [] : shifted(rest.slice(eq + 1), restAt + eq + 1);
      if (!target)
        return {
          reads: [...shifted(rest.slice(0, eq < 0 ? undefined : eq), restAt), ...reads],
          binds: [],
        };
      return { reads, binds: target[1]?.match(NAME) ?? [] };
    }
    case 'for': {
      const m = /^\s*\(?\s*([\w\s,]+?)\s*\)?\s+in\s/.exec(rest);
      if (!m) return { reads: shifted(rest, restAt), binds: [] };
      const at = restAt + m[0].length;
      const reads = shifted(body.slice(at), at).filter((t) => t.name !== 'recursive');
      return { reads, binds: m[1]?.match(NAME) ?? [] };
    }
    case 'with': {
      const binds = [...rest.matchAll(/([A-Za-z_]\w*)\s*=(?!=)/g)].map((m) => m[1] as string);
      return { reads: shifted(rest, restAt), binds };
    }
    case 'macro': {
      const m = /^\s*([A-Za-z_]\w*)\s*\(([^)]*)\)/.exec(rest);
      const args = (m?.[2] ?? '').split(',').map((a) => a.split('=')[0]?.trim() ?? '');
      return { reads: [], binds: [m?.[1] ?? '', ...args].filter(Boolean) };
    }
    default:
      return { reads: [], binds: [] };
  }
}

/** Every variable the value's Jinja reads, in order of appearance, without names it binds itself. */
export function parseRefs(value: string): string[] {
  const names: string[] = [];
  const bound = new Set<string>();
  for (const m of value.replaceAll(COMMENT, '').matchAll(TAG)) {
    if (m[1] !== undefined) {
      for (const t of identifiers(m[1])) if (!names.includes(t.name)) names.push(t.name);
      continue;
    }
    const s = statement(m[2] ?? '');
    for (const b of s.binds) bound.add(b);
    for (const t of s.reads) if (!names.includes(t.name)) names.push(t.name);
  }
  return bound.size ? names.filter((n) => !bound.has(n)) : names;
}

/**
 * The value with reads of `from` renamed to `to` (attribute names and literals untouched), in
 * expressions and statements alike; a name a statement binds is never renamed.
 */
export function renameRef(value: string, from: string, to: string): string {
  const rename = (body: string, tokens: Token[]) => {
    let out = '';
    let at = 0;
    for (const t of tokens) {
      if (t.name !== from) continue;
      out += body.slice(at, t.start) + to;
      at = t.start + from.length;
    }
    return out + body.slice(at);
  };
  // A name the template binds itself (a loop variable, a set) is its own: nothing to rename.
  for (const m of value.matchAll(TAG))
    if (m[2] !== undefined && statement(m[2]).binds.includes(from)) return value;
  return value.replaceAll(TAG, (tag, expr: string | undefined, stmt: string | undefined) => {
    if (expr !== undefined) return `{{${rename(expr, identifiers(expr))}}}`;
    const body = stmt ?? '';
    const s = statement(body);
    const open = tag.startsWith('{%-') ? '{%-' : '{%';
    const close = tag.endsWith('-%}') ? '-%}' : '%}';
    return `${open}${rename(body, s.reads)}${close}`;
  });
}

/**
 * A value that is one whole template, `{{ … }}` (AFD-112): a Timing setting given at run time,
 * which Ansible renders before the task runs, as against a number or a duration.
 */
export function templated(value: unknown): value is string {
  return typeof value === 'string' && /^\s*\{\{[\s\S]*\}\}\s*$/.test(value);
}

/** The one variable a template is, `{{ drain_tries }}` → drain_tries; not a field or expression. */
export function singleRef(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const name = SIMPLE.exec(value.trim())?.[1];
  return name && !name.includes('.') ? name : undefined;
}

/**
 * `renameRef` for a value Ansible reads as a bare expression (`until`): with braces it is a
 * template; without, every read of `from` in the whole text is renamed.
 */
export function renameExprRef(value: string, from: string, to: string): string {
  if (value.includes('{{')) return renameRef(value, from, to);
  let out = '';
  let at = 0;
  for (const t of identifiers(value)) {
    if (t.name !== from) continue;
    out += value.slice(at, t.start) + to;
    at = t.start + from.length;
  }
  return out + value.slice(at);
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

/** A decision condition wrapped whole in `{{ }}`: the expression inside it, else undefined. */
const WRAPPED = /^\{\{(?![\s\S]*\{\{)([\s\S]*?)\}\}$/;

/**
 * A decision condition as the generator writes it into `{{ ... if not (COND) ... }}` (AFD-146):
 * a condition written whole as `{{ x == 1 }}` loses the braces, which would otherwise nest and
 * fail to parse, and line breaks become spaces. Runs of spaces stay: they can be inside a string.
 */
export function conditionExpr(condition: string): string {
  const text = condition.trim();
  const inner = WRAPPED.exec(text)?.[1] ?? text;
  return inner.replaceAll(/\r\n|[\r\n]/g, ' ').trim();
}

/** Whether a condition still holds Jinja delimiters once a whole `{{ }}` wrapper is taken off. */
export const conditionHasBraces = (condition: string): boolean =>
  /\{\{|\}\}|\{%|%\}/.test(conditionExpr(condition));

// Jinja as coloured tokens (AFD-224, ADR-0034): what the fields colour and where the completion
// list (AFD-225) finds the caret. Lossless and forgiving: joined, the tokens give the text back, and
// a half-typed expression (an open string, call or tag) still colours. No library: this runs on
// every keystroke. core/flow/jinja.ts finds the variables a value reads; this one paints them.

export type JinjaKind =
  | 'delim'
  | 'comment'
  | 'keyword'
  | 'constant'
  | 'var'
  | 'func'
  | 'method'
  | 'attr'
  | 'filter'
  | 'test'
  | 'kwarg'
  | 'string'
  | 'format'
  | 'number'
  | 'op'
  | 'punct';

export interface JinjaToken {
  text: string;
  /** None for plain text outside the tags and for whitespace. */
  kind?: JinjaKind;
  start: number;
}

/** An open bracket: a call's arguments, a list or a dict. */
export interface Frame {
  open: '(' | '[' | '{';
  /** The name called: `now`, `strftime`, `lookup`, `default`. */
  callee?: string;
  calleeKind?: 'func' | 'method' | 'filter' | 'test';
  /** Where the callee's name starts. */
  calleeStart?: number;
  /** Which argument the scan is in, from 0. */
  arg: number;
  /** The keyword of the argument the scan is in (`fmt` in `now(fmt=`). */
  kwarg?: string;
}

/** Where the text ends: what the completion list needs to know about the caret. */
export interface ScanEnd {
  where: 'text' | 'expr' | 'stmt' | 'comment' | 'raw';
  /** The string the text ends inside. */
  string?: { quote: string; start: number };
  /** Open brackets, innermost last. */
  stack: Frame[];
  /** Where the expression or statement the text ends in starts (after its `{{` or `{%`). */
  exprStart: number;
  /** In a statement: its first word. */
  stmtWord?: string;
}

export interface ScanOptions {
  /** `template`: text with `{{ }}`; `expr`: a bare expression (when, until, assert that). */
  mode: 'template' | 'expr';
  /**
   * The text is the inside of a quoted YAML scalar: in `'…'` a Jinja quote is written `''`, in
   * `"…"` it is `\"`.
   */
  yamlQuote?: "'" | '"';
}

const KEYWORDS = new Set([
  'and',
  'or',
  'not',
  'in',
  'is',
  'if',
  'else',
  'elif',
  'for',
  'recursive',
  'as',
  'with',
  'without',
  'context',
  'import',
  'from',
  'ignore',
  'missing',
]);
const CONSTANTS = new Set(['true', 'false', 'none', 'True', 'False', 'None']);
const IDENT = /[A-Za-z_][A-Za-z0-9_]*/y;
const NUMBER =
  /0[xX][0-9a-fA-F_]+|0[oO][0-7_]+|0[bB][01_]+|[0-9][0-9_]*(?:\.[0-9_]+)?(?:[eE][+-]?[0-9]+)?/y;
const OPS = ['**', '//', '==', '!=', '<=', '>=', '+', '-', '*', '/', '%', '<', '>', '=', '~', '|'];
const PUNCT = '()[]{},.:';
/** strftime's codes, with the flags some platforms take (`%-d`). */
const FORMAT = /%[-_0^#]?[A-Za-z%]/g;

/** Whether a value Ansible reads bare is a template after all: one with braces is. */
export function exprMode(text: string, bare: boolean): ScanOptions['mode'] {
  return bare && !text.includes('{{') ? 'expr' : 'template';
}

export function scanJinja(text: string, opts: ScanOptions): { tokens: JinjaToken[]; end: ScanEnd } {
  const tokens: JinjaToken[] = [];
  const yq = opts.yamlQuote;
  let where = (opts.mode === 'expr' ? 'expr' : 'text') as ScanEnd['where'];
  let stack: Frame[] = [];
  let exprStart = 0;
  let stmtWord: string | undefined;
  let openString: ScanEnd['string'];
  /** The last token that was not whitespace, within the current tag. */
  let prev: JinjaToken | undefined;
  /** Whether the token before `prev` was `is` (so `is not x` names a test). */
  let afterIs = false;
  let i = 0;

  const push = (end: number, kind?: JinjaKind) => {
    if (end <= i) return;
    const t: JinjaToken = { text: text.slice(i, end), start: i, ...(kind ? { kind } : {}) };
    const last = tokens[tokens.length - 1];
    // Runs of plain text join into one token.
    if (!kind && last && !last.kind && last.start + last.text.length === i) last.text += t.text;
    else tokens.push(t);
    if (kind) {
      afterIs = prev?.kind === 'keyword' && prev.text === 'is' && t.text === 'not';
      prev = t;
    }
    i = end;
  };

  /** A Jinja quote at `j`: its character and how long it is written. */
  const quoteAt = (j: number): { q: string; len: number } | undefined => {
    if (yq === "'" && text.startsWith("''", j)) return { q: "'", len: 2 };
    if (yq === '"' && text.startsWith('\\"', j)) return { q: '"', len: 2 };
    const c = text[j];
    if ((c === "'" && yq !== "'") || (c === '"' && yq !== '"')) return { q: c, len: 1 };
    return undefined;
  };

  /** A string from `i`: string pieces and strftime codes, to its closing quote or the end. */
  const scanString = (open: { q: string; len: number }) => {
    const start = i;
    let j = i + open.len;
    let closed = false;
    while (j < text.length) {
      const q = quoteAt(j);
      if (q && q.q === open.q) {
        j += q.len;
        closed = true;
        break;
      }
      if (text[j] === '\\' && !(yq === '"' && text[j + 1] === '"')) j += 2;
      else j++;
    }
    const end = Math.min(j, text.length);
    const body = text.slice(start, end);
    let at = 0;
    for (const m of body.matchAll(FORMAT)) {
      const s = m.index ?? 0;
      if (s > at) push(start + s, 'string');
      push(start + s + m[0].length, 'format');
      at = s + m[0].length;
    }
    push(end, 'string');
    if (!closed) openString = { quote: open.q, start };
  };

  const identKind = (name: string, end: number): JinjaKind => {
    if (where === 'stmt' && !stmtWord) return 'keyword';
    if (CONSTANTS.has(name)) return 'constant';
    const p = prev;
    if (p?.text === '|') return 'filter';
    if ((p?.kind === 'keyword' && p.text === 'is' && name !== 'not') || afterIs) return 'test';
    if (KEYWORDS.has(name)) return 'keyword';
    const after = /^\s*(\(|=(?!=))?/.exec(text.slice(end))?.[1];
    if (p?.text === '.') return after === '(' ? 'method' : 'attr';
    if (after === '=' && stack[stack.length - 1]?.open === '(') return 'kwarg';
    if (after === '(') return 'func';
    return 'var';
  };

  /** The tag's end at `i`, if there is one: `}}`, `-}}`, `%}`, `-%}`, `+%}`. */
  const closeAt = (): number => {
    if (stack.length > 0) return 0;
    const m = (where === 'expr' ? /[-+]?\}\}/y : /[-+]?%\}/y) as RegExp;
    m.lastIndex = i;
    return m.test(text) ? m.lastIndex - i : 0;
  };

  while (i < text.length) {
    if (where === 'text' || where === 'raw') {
      const next: RegExp = where === 'raw' ? /\{%[-+]?\s*endraw\s*[-+]?%\}/g : /\{\{|\{%|\{#/g;
      next.lastIndex = i;
      const m = next.exec(text);
      if (!m) {
        push(text.length);
        break;
      }
      push(m.index);
      if (where === 'raw') {
        push(i + m[0].length, 'delim');
        where = 'text';
        continue;
      }
      if (m[0] === '{#') {
        const close = text.indexOf('#}', i + 2);
        if (close < 0) {
          push(text.length, 'comment');
          where = 'comment';
          break;
        }
        push(close + 2, 'comment');
        continue;
      }
      const ws = /[-+]?/y;
      ws.lastIndex = i + 2;
      ws.test(text);
      push(ws.lastIndex, 'delim');
      where = m[0] === '{{' ? 'expr' : 'stmt';
      exprStart = i;
      stmtWord = undefined;
      stack = [];
      prev = undefined;
      afterIs = false;
      continue;
    }
    // Inside an expression or a statement.
    const close = opts.mode === 'expr' ? 0 : closeAt();
    if (close) {
      push(i + close, 'delim');
      // `{% raw %}` keeps what follows as text up to `{% endraw %}`.
      where = stmtWord === 'raw' ? 'raw' : 'text';
      prev = undefined;
      continue;
    }
    const c = text[i] as string;
    if (/\s/.test(c)) {
      const ws = /\s+/y;
      ws.lastIndex = i;
      ws.test(text);
      push(ws.lastIndex);
      continue;
    }
    const q = quoteAt(i);
    if (q) {
      scanString(q);
      continue;
    }
    IDENT.lastIndex = i;
    const id = IDENT.exec(text);
    if (id) {
      const end = i + id[0].length;
      const kind = identKind(id[0], end);
      if (where === 'stmt' && !stmtWord) stmtWord = id[0];
      const top = stack[stack.length - 1];
      if (kind === 'kwarg' && top) top.kwarg = id[0];
      push(end, kind);
      continue;
    }
    NUMBER.lastIndex = i;
    const num = NUMBER.exec(text);
    if (num) {
      push(i + num[0].length, 'number');
      continue;
    }
    if (PUNCT.includes(c)) {
      const top = stack[stack.length - 1];
      if (c === '(' || c === '[' || c === '{') {
        const callee =
          c === '(' && prev && prev.start + prev.text.length === i
            ? prev.kind === 'func' ||
              prev.kind === 'method' ||
              prev.kind === 'filter' ||
              prev.kind === 'test'
              ? prev
              : undefined
            : undefined;
        stack.push({
          open: c,
          arg: 0,
          ...(callee
            ? {
                callee: callee.text,
                calleeKind: callee.kind as Frame['calleeKind'],
                calleeStart: callee.start,
              }
            : {}),
        });
      } else if (c === ',' && top) {
        top.arg++;
        delete top.kwarg;
      } else if (
        top &&
        ((c === ')' && top.open === '(') ||
          (c === ']' && top.open === '[') ||
          (c === '}' && top.open === '{'))
      ) {
        stack.pop();
      }
      push(i + 1, 'punct');
      continue;
    }
    const op = OPS.find((o) => text.startsWith(o, i));
    push(i + (op?.length ?? 1), op ? 'op' : 'punct');
  }

  return {
    tokens,
    end: {
      where,
      ...(openString ? { string: openString } : {}),
      stack: stack.map((f) => ({ ...f })),
      exprStart,
      ...(stmtWord ? { stmtWord } : {}),
    },
  };
}

/** A colour of the fields' syntax palette (`--afd-syn-<colour>`, ADR-0034). */
export type SyntaxColour =
  | 'delim'
  | 'keyword'
  | 'constant'
  | 'var'
  | 'func'
  | 'string'
  | 'format'
  | 'number'
  | 'comment'
  | 'key';

/** VS Code's scopes, folded: operators and punctuation keep the text colour. */
export const COLOUR_OF: Partial<Record<JinjaKind, SyntaxColour>> = {
  delim: 'delim',
  comment: 'comment',
  keyword: 'keyword',
  constant: 'constant',
  var: 'var',
  attr: 'var',
  kwarg: 'var',
  func: 'func',
  method: 'func',
  filter: 'func',
  test: 'func',
  string: 'string',
  format: 'format',
  number: 'number',
};

/** The coloured stretches of a value: what a field paints. */
export function jinjaColours(
  text: string,
  opts: ScanOptions,
): { start: number; end: number; colour: SyntaxColour }[] {
  const out: { start: number; end: number; colour: SyntaxColour }[] = [];
  for (const t of scanJinja(text, opts).tokens) {
    const colour = t.kind && COLOUR_OF[t.kind];
    if (!colour) continue;
    const last = out[out.length - 1];
    if (last && last.colour === colour && last.end === t.start) last.end = t.start + t.text.length;
    else out.push({ start: t.start, end: t.start + t.text.length, colour });
  }
  return out;
}

// What the completion list offers at the caret (AFD-225): variables and globals where a value
// starts, filters after `|`, tests after `is`, the members of a value after `.` (a datetime's
// strftime, a result's fields), strftime's codes inside a format and lookup names inside lookup().
// Pure: the fields call it with their text and caret, and draw what it returns.
import type { RefChoice } from '../catalog/draft';
import { type JinjaToken, type ScanOptions, scanJinja } from './jinjaText';
import {
  CONSTANTS,
  FIELD_TYPES,
  FILTER_RETURNS,
  FILTERS,
  GLOBALS,
  LOOKUPS,
  MAGIC,
  MEMBERS,
  OPERATORS,
  STATEMENTS,
  STRFTIME_CODES,
  STRFTIME_PRESETS,
  strftime,
  TESTS,
  type ValueType,
  type Word,
} from './jinjaVocabulary';

/** A filter, test or lookup the catalog lists (AFD-225: catalog `names`). */
export interface PluginName {
  /** What a template writes: the short name for ansible.builtin, else the FQCN. */
  name: string;
  fqcn: string;
  doc?: string;
}

export interface CompleteContext {
  /** What the node can read (`refChoices`), with their result fields. */
  vars: readonly RefChoice[];
  filters?: readonly PluginName[];
  tests?: readonly PluginName[];
  lookups?: readonly PluginName[];
  /** The time previews show (tests fix it). */
  now?: Date;
}

export type ItemKind =
  | 'variable'
  | 'function'
  | 'method'
  | 'field'
  | 'filter'
  | 'test'
  | 'lookup'
  | 'keyword'
  | 'format';

export interface CompletionItem {
  label: string;
  /** Replaces `from`..`to`. */
  insert: string;
  /** Where the caret goes in `insert` (else after it). */
  caret?: number;
  kind: ItemKind;
  /** A short note beside the label (a type, a source). */
  detail?: string;
  /** The help under the list. */
  doc?: string;
  sig?: string;
  /** What a date format gives now. */
  preview?: string;
  /** A variable that is not an input yet: choosing it stages one. */
  choice?: RefChoice;
  /** The list opens again after it is inserted. */
  again?: boolean;
}

export interface SignatureHint {
  /** `now(utc=False, fmt=None)`. */
  label: string;
  doc?: string;
  /** Which argument the caret is in. */
  arg: number;
  /** What the format typed so far gives now. */
  preview?: string;
}

export interface Completion {
  from: number;
  to: number;
  items: CompletionItem[];
  /** What the list offers: for its heading and the tests. */
  context: 'value' | 'filter' | 'test' | 'member' | 'format' | 'lookup' | 'statement' | 'operator';
  hint?: SignatureHint;
}

const IDENT_KINDS = new Set([
  'var',
  'func',
  'method',
  'attr',
  'filter',
  'test',
  'kwarg',
  'keyword',
  'constant',
]);
const MAX = 60;

/** Exact, then prefix, then substring matches, each kept in order (as filterParams ranks). */
function ranked<T>(list: readonly T[], query: string, name: (t: T) => string): T[] {
  const q = query.toLowerCase();
  if (!q) return list.slice(0, MAX);
  const tier = (t: T) => {
    const n = name(t).toLowerCase();
    if (n === q) return 0;
    if (n.startsWith(q)) return 1;
    // A collection plugin by its own name: community.general.json_query for `json`.
    if (n.split('.').at(-1)?.startsWith(q)) return 2;
    if (n.includes(q)) return 3;
    return -1;
  };
  return list
    .map((t, i) => ({ t, i, r: tier(t) }))
    .filter((x) => x.r >= 0)
    .sort((a, b) => a.r - b.r || a.i - b.i)
    .slice(0, MAX)
    .map((x) => x.t);
}

const wordItem = (w: Word, kind: ItemKind, detail?: string): CompletionItem => ({
  // Calls show what they insert (`now(utc=true)`, `upper()`); other words their name.
  label: w.insert && (kind === 'function' || kind === 'method') ? w.insert : w.name,
  insert: w.insert ?? w.name,
  ...(w.caret !== undefined ? { caret: w.caret } : {}),
  kind,
  ...(detail ? { detail } : {}),
  doc: w.doc,
  ...(w.sig ? { sig: w.sig } : {}),
  ...(w.again ? { again: true } : {}),
});

/** Static words and the catalog's plugins, one per name; the static doc wins. */
function plugins(words: readonly Word[], listed: readonly PluginName[] = []): Word[] {
  const out = [...words];
  const have = new Set(words.map((w) => w.name));
  for (const p of listed)
    if (!have.has(p.name)) {
      have.add(p.name);
      out.push({ name: p.name, doc: p.doc ?? p.fqcn });
    }
  return out;
}

/** The significant token before index `i` (skipping whitespace). */
function before(tokens: JinjaToken[], i: number): { t: JinjaToken; i: number } | undefined {
  for (let j = i - 1; j >= 0; j--) {
    const t = tokens[j] as JinjaToken;
    if (t.kind) return { t, i: j };
    if (t.text.trim()) return undefined;
  }
  return undefined;
}

/** The index of the bracket that opens the one closing at `close`. */
function opening(tokens: JinjaToken[], close: number): number {
  const pairs: Record<string, string> = { ')': '(', ']': '[', '}': '{' };
  const want = pairs[tokens[close]?.text ?? ''];
  let depth = 0;
  for (let j = close; j >= 0; j--) {
    const t = tokens[j] as JinjaToken;
    if (t.kind !== 'punct') continue;
    if (t.text === tokens[close]?.text) depth++;
    else if (t.text === want && --depth === 0) return j;
  }
  return -1;
}

/**
 * What the value ending at token `end` is: enough to offer its members. `now(...)` is a datetime
 * (text with `fmt=`), a string literal is text, a result's field has its documented type.
 */
function typeAt(
  tokens: JinjaToken[],
  end: number,
  ctx: CompleteContext,
): { type?: ValueType; choice?: RefChoice } {
  const t = tokens[end];
  if (!t) return {};
  if (t.kind === 'string') return { type: 'str' };
  if (t.text === ')') {
    const open = opening(tokens, end);
    const callee = open > 0 ? before(tokens, open) : undefined;
    const inner = tokens.slice(open + 1, end);
    if (callee && callee.t.start + callee.t.text.length === tokens[open]?.start) {
      const name = callee.t.text;
      if (callee.t.kind === 'func' && name === 'now')
        return {
          type: inner.some((x) => x.kind === 'kwarg' && x.text === 'fmt') ? 'str' : 'datetime',
        };
      if (callee.t.kind === 'func') return { type: GLOBALS.find((g) => g.name === name)?.returns };
      if (callee.t.kind === 'filter') return { type: FILTER_RETURNS[name] };
      if (callee.t.kind === 'method') {
        const dot = before(tokens, callee.i);
        const recv = dot?.t.text === '.' ? before(tokens, dot.i) : undefined;
        const of = recv ? typeAt(tokens, recv.i, ctx).type : undefined;
        return { type: of ? MEMBERS[of].find((w) => w.name === name)?.returns : undefined };
      }
    }
    // `( … | to_datetime )`: the last filter at the top level of the brackets.
    let depth = 0;
    for (let j = end - 1; j > open; j--) {
      const x = tokens[j] as JinjaToken;
      if (x.text === ')' || x.text === ']') depth++;
      else if (x.text === '(' || x.text === '[') depth--;
      else if (depth === 0 && x.kind === 'filter') return { type: FILTER_RETURNS[x.text] };
    }
    return {};
  }
  if (t.kind === 'filter') return { type: FILTER_RETURNS[t.text] };
  if (t.kind === 'var') {
    const choice = ctx.vars.find((c) => c.name === t.text);
    if (choice) return { choice };
    if (t.text === 'loop') return { type: 'loop' };
    return { type: MAGIC.find((w) => w.name === t.text)?.returns };
  }
  if (t.kind === 'attr') {
    const dot = before(tokens, tokens.indexOf(t));
    const base = dot?.t.text === '.' ? before(tokens, dot.i) : undefined;
    if (base?.t.kind === 'var' && ctx.vars.some((c) => c.name === base.t.text && c.fields))
      return { type: FIELD_TYPES[t.text] };
    if (base) {
      const of = typeAt(tokens, base.i, ctx).type;
      if (of) return { type: MEMBERS[of].find((w) => w.name === t.text)?.returns };
    }
  }
  return {};
}

function formatItems(prefix: string, open: boolean, now: Date, utc: boolean): CompletionItem[] {
  const presets: CompletionItem[] = open
    ? STRFTIME_PRESETS.map((p) => ({
        label: p.format,
        insert: p.format,
        kind: 'format',
        detail: p.doc,
        doc: `${p.doc}: ${p.format}`,
        preview: strftime(p.format, now, utc),
      }))
    : [];
  const codes = STRFTIME_CODES.filter((c) => !prefix || c.code.startsWith(prefix)).map(
    (c): CompletionItem => ({
      label: c.code,
      insert: c.code,
      kind: 'format',
      detail: c.doc,
      doc: c.doc,
      preview: strftime(c.code, now, utc),
      again: true,
    }),
  );
  return [...presets, ...codes];
}

/** Whether the call the caret is in reads its date in UTC: `now(utc=true).strftime(`. */
function utcCall(tokens: JinjaToken[]): boolean {
  const text = tokens.map((t) => t.text).join('');
  return /now\(\s*utc\s*=\s*(true|True)\s*\)\s*\.\s*strftime\(\s*['"][^'"]*$/.test(text);
}

/** The words and signature of a call the caret is in. */
function signatureOf(callee: string, kind: string | undefined): Word | undefined {
  if (kind === 'func') return GLOBALS.find((g) => g.name === callee && g.sig);
  if (kind === 'filter') return FILTERS.find((w) => w.name === callee);
  if (kind === 'test') return TESTS.find((w) => w.name === callee);
  if (kind === 'method')
    for (const list of Object.values(MEMBERS)) {
      const w = list.find((x) => x.name === callee && x.sig);
      if (w) return w;
    }
  return undefined;
}

/** The signature of the call the caret is in, with a preview of a date format. */
export function signatureAt(
  text: string,
  caret: number,
  opts: ScanOptions,
  ctx: Pick<CompleteContext, 'now'> = {},
): SignatureHint | undefined {
  const { tokens, end } = scanJinja(text.slice(0, caret), opts);
  if (end.where !== 'expr' && end.where !== 'stmt') return undefined;
  const frame = [...end.stack].reverse().find((f) => f.open === '(' && f.callee);
  if (!frame?.callee) return undefined;
  const w = signatureOf(frame.callee, frame.calleeKind);
  if (!w?.sig) return undefined;
  const hint: SignatureHint = { label: w.sig, doc: w.doc, arg: frame.arg };
  const formatArg =
    (frame.callee === 'strftime' && frame.calleeKind === 'method') ||
    (frame.callee === 'now' && frame.kwarg === 'fmt') ||
    (frame.callee === 'to_datetime' && frame.calleeKind === 'filter');
  if (formatArg && end.string) {
    const typed = text.slice(end.string.start + 1, caret);
    const rest = /^[^'"]*/.exec(text.slice(caret))?.[0] ?? '';
    hint.preview = strftime(typed + rest, ctx.now ?? new Date(), utcCall(tokens));
  }
  return hint;
}

/** What the list offers at the caret, or nothing. */
export function complete(
  text: string,
  caret: number,
  opts: ScanOptions,
  ctx: CompleteContext,
): Completion | undefined {
  const head = text.slice(0, caret);
  const { tokens, end } = scanJinja(head, opts);
  if (end.where !== 'expr' && end.where !== 'stmt') return undefined;
  const now = ctx.now ?? new Date();
  const hint = signatureAt(text, caret, opts, ctx);
  const wordAfter = /^[A-Za-z0-9_]*/.exec(text.slice(caret))?.[0] ?? '';

  if (end.string) {
    const frame = end.stack[end.stack.length - 1];
    const typed = head.slice(end.string.start + 1);
    if (
      frame &&
      ((frame.callee === 'strftime' && frame.calleeKind === 'method' && frame.arg === 0) ||
        (frame.callee === 'now' && frame.kwarg === 'fmt') ||
        (frame.callee === 'to_datetime' && frame.calleeKind === 'filter' && frame.arg === 0))
    ) {
      const code = /%[-_0^#]?[A-Za-z]?$/.exec(typed)?.[0] ?? '';
      const items = formatItems(code, typed === '', now, utcCall(tokens));
      return items.length
        ? {
            from: caret - code.length,
            to: caret,
            items,
            context: 'format',
            ...(hint ? { hint } : {}),
          }
        : undefined;
    }
    if (
      frame &&
      frame.calleeKind === 'func' &&
      ['lookup', 'query', 'q'].includes(frame.callee ?? '') &&
      frame.arg === 0
    ) {
      const items = ranked(plugins(LOOKUPS, ctx.lookups), typed, (w) => w.name).map((w) =>
        wordItem({ ...w, insert: w.name }, 'lookup'),
      );
      return items.length
        ? {
            from: end.string.start + 1,
            to: caret + wordAfter.length,
            items,
            context: 'lookup',
            ...(hint ? { hint } : {}),
          }
        : undefined;
    }
    return undefined;
  }

  // The word being typed, if the caret is at the end of one.
  const last = tokens[tokens.length - 1];
  const typing =
    last?.kind && IDENT_KINDS.has(last.kind) && last.start + last.text.length === caret
      ? last
      : undefined;
  const prefix = typing?.text ?? '';
  const from = typing ? typing.start : caret;
  const to = caret + wordAfter.length;
  const prev = before(tokens, typing ? tokens.length - 1 : tokens.length);
  const result = (
    items: CompletionItem[],
    context: Completion['context'],
  ): Completion | undefined =>
    items.length ? { from, to, items, context, ...(hint ? { hint } : {}) } : undefined;

  // The first word of a statement.
  if (end.where === 'stmt' && (!end.stmtWord || (typing && prev?.t.kind === 'delim')))
    return result(
      ranked(STATEMENTS, prefix, (w) => w.name).map((w) => wordItem(w, 'keyword')),
      'statement',
    );

  if (prev?.t.text === '|')
    return result(
      ranked(plugins(FILTERS, ctx.filters), prefix, (w) => w.name).map((w) =>
        wordItem(w, 'filter'),
      ),
      'filter',
    );

  const isTest =
    (prev?.t.kind === 'keyword' && prev.t.text === 'is') ||
    (prev?.t.kind === 'keyword' &&
      prev.t.text === 'not' &&
      before(tokens, prev.i)?.t.text === 'is');
  if (isTest)
    return result(
      ranked(plugins(TESTS, ctx.tests), prefix, (w) => w.name).map((w) => wordItem(w, 'test')),
      'test',
    );

  if (prev?.t.text === '.') {
    const recv = before(tokens, prev.i);
    if (!recv) return undefined;
    const { type, choice } = typeAt(tokens, recv.i, ctx);
    if (choice?.fields)
      return result(
        ranked(choice.fields, prefix, (f) => f.name).map((f) => ({
          label: f.name,
          insert: f.name,
          kind: 'field',
          detail: FIELD_TYPES[f.name],
          doc: f.detail,
        })),
        'member',
      );
    if (!type) return undefined;
    const items: CompletionItem[] = [];
    const utc = /utc\s*=\s*(true|True)/.test(
      tokens
        .slice(Math.max(0, recv.i - 8), recv.i + 1)
        .map((t) => t.text)
        .join(''),
    );
    for (const w of ranked(MEMBERS[type], prefix, (x) => x.name)) {
      if (w.name === 'strftime') {
        // The formats people use most, ready to insert, each with what it gives now.
        for (const p of STRFTIME_PRESETS)
          items.push({
            label: `strftime('${p.format}')`,
            insert: `strftime('${p.format}')`,
            kind: 'method',
            detail: p.doc,
            doc: w.doc,
            sig: w.sig,
            preview: strftime(p.format, now, utc),
          });
      }
      items.push(wordItem(w, w.insert ? 'method' : 'field', w.returns));
    }
    return result(items, 'member');
  }

  // After a whole operand: the words that join operands.
  const operand =
    prev &&
    (prev.t.kind === 'var' ||
      prev.t.kind === 'attr' ||
      prev.t.kind === 'string' ||
      prev.t.kind === 'number' ||
      prev.t.kind === 'constant' ||
      prev.t.kind === 'filter' ||
      prev.t.kind === 'test' ||
      prev.t.text === ')' ||
      prev.t.text === ']');
  if (operand) {
    if (!prefix) return undefined;
    return result(
      ranked(OPERATORS, prefix, (w) => w.name).map((w) => wordItem(w, 'keyword')),
      'operator',
    );
  }

  // Where a value starts: the node's variables, Ansible's, the globals, constants and `not`.
  const vars: CompletionItem[] = ctx.vars.map((c) => ({
    label: c.name,
    insert: c.name,
    kind: 'variable',
    detail: c.label !== c.name ? c.label : c.detail,
    doc: c.detail,
    ...(c.field ? { choice: c } : {}),
  }));
  const pool: CompletionItem[] = [
    ...vars,
    ...MAGIC.map((w) => wordItem(w, 'variable')),
    ...GLOBALS.map((w) => wordItem(w, 'function', w.returns)),
    ...CONSTANTS.map((w) => wordItem(w, 'keyword')),
    wordItem(OPERATORS[2] as Word, 'keyword'),
  ];
  // A name a step reads twice (an input and Ansible's) is offered once.
  const seen = new Set<string>();
  const unique = pool.filter((i) => !seen.has(i.insert) && seen.add(i.insert));
  return result(
    ranked(unique, prefix, (i) => i.insert).map((i) => i),
    'value',
  );
}

/** What hovering a name shows (AFD-226): its signature or name, what it does, a date's preview. */
export interface Description {
  label: string;
  doc?: string;
  preview?: string;
}

/** The help for the token at `offset`: a function, method, filter, test, variable or date code. */
export function describeAt(
  text: string,
  offset: number,
  opts: ScanOptions,
  ctx: CompleteContext,
): Description | undefined {
  const { tokens } = scanJinja(text, opts);
  const i = tokens.findIndex((t) => t.start <= offset && offset < t.start + t.text.length);
  const t = tokens[i];
  if (!t?.kind) return undefined;
  const word = (w: Word | undefined): Description | undefined =>
    w ? { label: w.sig ?? w.name, doc: w.doc } : undefined;
  switch (t.kind) {
    case 'func':
      return word(
        GLOBALS.find((g) => g.name === t.text && g.sig) ?? GLOBALS.find((g) => g.name === t.text),
      );
    case 'method':
    case 'attr':
      for (const list of Object.values(MEMBERS)) {
        const w = list.find((x) => x.name === t.text);
        if (w) return word(w);
      }
      return undefined;
    case 'filter':
      return word(plugins(FILTERS, ctx.filters).find((w) => w.name === t.text));
    case 'test':
      return word(plugins(TESTS, ctx.tests).find((w) => w.name === t.text));
    case 'var': {
      const choice = ctx.vars.find((c) => c.name === t.text);
      if (choice) return { label: choice.name, doc: choice.detail };
      return word(MAGIC.find((w) => w.name === t.text));
    }
    case 'format': {
      const code = STRFTIME_CODES.find((c) => c.code === t.text.replace(/^%[-_0^#]/, '%'));
      return code
        ? {
            label: t.text,
            doc: code.doc,
            preview: strftime(t.text, ctx.now ?? new Date(), utcCall(tokens.slice(0, i))),
          }
        : undefined;
    }
    case 'string': {
      // A lookup's name: lookup('env', …).
      const open = before(tokens, i);
      const callee = open?.t.text === '(' ? before(tokens, open.i) : undefined;
      if (callee?.t.kind === 'func' && ['lookup', 'query', 'q'].includes(callee.t.text)) {
        const name = t.text.replace(/^['"]|['"]$/g, '');
        return word(plugins(LOOKUPS, ctx.lookups).find((w) => w.name === name));
      }
      return undefined;
    }
    default:
      return undefined;
  }
}

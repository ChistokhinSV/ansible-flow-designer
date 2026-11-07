// Renders new YAML text in the style of the file being edited (indent unit, sequence indentation, EOL).
import { parse } from 'yaml';

export interface Style {
  eol: '\n' | '\r\n';
  indentUnit: number;
  /** `key:\n- item` (true) versus `key:\n  - item` (false). */
  seqIndentless: boolean;
}

export type QuoteHint = 'PLAIN' | 'QUOTE_SINGLE' | 'QUOTE_DOUBLE' | undefined;

type Plain = string | number | boolean | null;

/**
 * A string written as a literal block (`|-`) when it spans lines and reads back the same, else as a
 * quoted scalar (AFD-64: annotation text stays readable in the file and in diffs). Opt-in, so
 * other multi-line strings keep the quoted form writers and goldens rely on.
 */
export class Literal {
  constructor(readonly text: string) {}
}

/** A short list written inline (`[host-01, host-02]`), as people write lists of names (AFD-115). */
export class FlowList {
  constructor(readonly items: readonly Plain[]) {}
}

export type YamlValue = Plain | Literal | FlowList | YamlValue[] | { [key: string]: YamlValue };

/** `|-` / `|` and the content lines at `col`, or undefined where a literal block would not fit. */
export function literalLines(
  text: string,
  col: number,
): { indicator: string; lines: string[] } | undefined {
  if (!text.includes('\n') || /[\r\u0085\u2028\u2029\ufeff]/.test(text)) return undefined;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < 0x20 && c !== 0x0a && c !== 0x09) return undefined;
  }
  const trailing = /\n*$/.exec(text)?.[0].length ?? 0;
  if (trailing > 1) return undefined;
  const body = trailing ? text.slice(0, -1) : text;
  const rows = body.split('\n');
  // A leading space would be read as indentation; a blank line with spaces cannot be written.
  if (/^[ \t]/.test(rows[0] ?? '') || rows.some((r) => r !== '' && r.trim() === ''))
    return undefined;
  const pad = ' '.repeat(Math.max(col, 1));
  const indicator = trailing ? '|' : '|-';
  const lines = rows.map((r) => (r === '' ? '' : pad + r));
  try {
    if (parse(`k: ${indicator}\n${lines.join('\n')}\n`)?.k !== text) return undefined;
  } catch {
    return undefined;
  }
  return { indicator, lines };
}

const plainOf = (v: Plain | Literal): Plain => (v instanceof Literal ? v.text : v);

const INDICATORS = /^[-?:,[\]{}#&*!|>'"%@`\s]/;

export function isPlainSafe(s: string): boolean {
  if (s === '' || s !== s.trim() || /[\n\r\t]/.test(s) || INDICATORS.test(s)) return false;
  if (s.includes(': ') || s.includes(' #') || s.endsWith(':')) return false;
  // Must read back as the same string under both YAML 1.2 (core) and 1.1 (yes/no/on/off, octals,
  // sexagesimals, timestamps), since flow files may be read by Ansible-side tooling too.
  // Single-letter y/n stay plain: PyYAML (what Ansible uses) reads them as strings, and layout
  // entries are written as `x:`/`y:`.
  try {
    return parse(s) === s && (/^[yYnN]$/.test(s) || parse(s, { version: '1.1' }) === s);
  } catch {
    return false;
  }
}

/** Line breaks, tabs and other C0 controls need a double-quoted scalar with escapes. */
function hasControlChars(s: string): boolean {
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) < 0x20) return true;
  return false;
}

function single(s: string): string {
  return `'${s.replaceAll("'", "''")}'`;
}

function double(s: string): string {
  return JSON.stringify(s);
}

export function renderScalar(value: Plain, hint?: QuoteHint): string {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`cannot render ${value}`);
    return String(value);
  }
  if (hasControlChars(value) || hint === 'QUOTE_DOUBLE') return double(value);
  if (hint === 'QUOTE_SINGLE') return single(value);
  return isPlainSafe(value) ? value : single(value);
}

export function renderKey(key: string): string {
  return isPlainSafe(key) ? key : single(key);
}

function isPlainValue(v: YamlValue): v is Plain | Literal {
  return v === null || typeof v !== 'object' || v instanceof Literal;
}

function isEmptyCollection(v: YamlValue): boolean {
  return Array.isArray(v)
    ? v.length === 0
    : typeof v === 'object' && v !== null && Object.keys(v).length === 0;
}

/**
 * Inline form for scalars and empty collections; undefined when the value needs block lines. A
 * literal that fits a block is rendered by the caller (`literalLines`), after its key.
 */
export function renderInline(v: YamlValue, hint?: QuoteHint): string | undefined {
  if (v instanceof Literal && literalLines(v.text, 2)) return undefined;
  if (v instanceof FlowList) return renderFlow([...v.items]);
  if (isPlainValue(v)) return renderScalar(plainOf(v), hint);
  if (isEmptyCollection(v)) return Array.isArray(v) ? '[]' : '{}';
  return undefined;
}

/** Inside a flow collection a plain scalar also ends at `,` and brackets, so those get quotes. */
function flowSafe(rendered: string): string {
  return isPlainSafe(rendered) && /[,[\]{}]/.test(rendered) ? single(rendered) : rendered;
}

/** Flow style for a value inside a flow collection (`[a, b]`, `{x: 1}`). */
export function renderFlow(v: YamlValue, hint?: QuoteHint): string {
  if (isPlainValue(v)) return flowSafe(renderScalar(plainOf(v), hint));
  if (v instanceof FlowList) return renderFlow([...v.items]);
  if (Array.isArray(v)) return `[${v.map((x) => renderFlow(x)).join(', ')}]`;
  return `{${Object.entries(v)
    .map(([k, x]) => `${flowSafe(renderKey(k))}: ${renderFlow(x)}`)
    .join(', ')}}`;
}

/**
 * Block lines (without line ends) for a non-empty map or sequence whose content starts at `col`.
 * With `inlineFirst`, the first line carries no indentation (it continues a `- ` already written).
 */
export function renderBlock(
  v: YamlValue,
  col: number,
  style: Style,
  inlineFirst = false,
): string[] {
  const pad = ' '.repeat(col);
  const lines: string[] = [];
  const push = (line: string) => {
    lines.push(inlineFirst && lines.length === 0 ? line.slice(col) : line);
  };
  if (Array.isArray(v)) {
    for (const item of v) {
      const inline = item instanceof Literal ? renderScalar(item.text) : renderInline(item);
      if (inline !== undefined) {
        push(`${pad}- ${inline}`);
        continue;
      }
      const inner = renderBlock(item, col + 2, style, true);
      push(`${pad}- ${inner[0]}`);
      lines.push(...inner.slice(1));
    }
    return lines;
  }
  for (const [k, x] of Object.entries(v as Record<string, YamlValue>)) {
    const key = renderKey(k);
    const literal = x instanceof Literal ? literalLines(x.text, col + style.indentUnit) : undefined;
    if (literal) {
      push(`${pad}${key}: ${literal.indicator}`);
      lines.push(...literal.lines);
      continue;
    }
    const inline = renderInline(x);
    if (inline !== undefined) {
      push(`${pad}${key}: ${inline}`);
      continue;
    }
    push(`${pad}${key}:`);
    const childCol = Array.isArray(x) && style.seqIndentless ? col : col + style.indentUnit;
    lines.push(...renderBlock(x, childCol, style));
  }
  return lines;
}

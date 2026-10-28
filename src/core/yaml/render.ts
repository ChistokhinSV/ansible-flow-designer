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
export type YamlValue = Plain | YamlValue[] | { [key: string]: YamlValue };

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

function isPlainValue(v: YamlValue): v is Plain {
  return v === null || typeof v !== 'object';
}

function isEmptyCollection(v: YamlValue): boolean {
  return Array.isArray(v)
    ? v.length === 0
    : typeof v === 'object' && v !== null && Object.keys(v).length === 0;
}

/** Inline form for scalars and empty collections; undefined when the value needs block lines. */
export function renderInline(v: YamlValue, hint?: QuoteHint): string | undefined {
  if (isPlainValue(v)) return renderScalar(v, hint);
  if (isEmptyCollection(v)) return Array.isArray(v) ? '[]' : '{}';
  return undefined;
}

/** Flow style for re-rendering an existing non-empty flow collection (`[a, b]`, `{x: 1}`). */
export function renderFlow(v: YamlValue): string {
  if (isPlainValue(v)) return renderScalar(v);
  if (Array.isArray(v)) return `[${v.map(renderFlow).join(', ')}]`;
  return `{${Object.entries(v)
    .map(([k, x]) => `${renderKey(k)}: ${renderFlow(x)}`)
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
      const inline = renderInline(item);
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

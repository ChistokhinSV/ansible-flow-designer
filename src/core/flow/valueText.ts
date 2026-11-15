// AFD-286: a value typed in a one-line field, read the way YAML (and so Ansible) reads it, and
// shown back so it reads the same again. Unquoted `[a, b]` is a list and `{k: v}` a map; a quoted
// value is the text inside the quotes; `{{ ... }}` and `{% ... %}` stay templates. Anything else
// is text, as the field always kept it (numbers too: Ansible converts where it needs).
import { parse, stringify } from 'yaml';

const TEMPLATE = /^\s*\{[{%]/;
const QUOTED = /^(".*"|'.*')$/s;
const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

function yaml(text: string): unknown {
  try {
    return parse(text);
  } catch {
    return undefined;
  }
}

/** What a typed line means: a list or map in YAML flow syntax, else its text. */
export function valueOfText(text: string): unknown {
  const t = text.trim();
  if (TEMPLATE.test(t)) return text;
  if (t.startsWith('[') || t.startsWith('{')) {
    const v = yaml(t);
    if (Array.isArray(v) || isRecord(v)) return v;
    return text;
  }
  // A quoted list or map is the text inside the quotes: the way to keep "[a, b]" as text. Other
  // quotes stay as typed (they always did).
  if (QUOTED.test(t)) {
    const v = yaml(t);
    if (typeof v === 'string' && needsQuotes(v.trim())) return v;
  }
  return text;
}

/** Text that `valueOfText` would not give back as it is: quoted so it reads as text again. */
function needsQuotes(t: string): boolean {
  if (QUOTED.test(t)) return /^.\s*[[{]/.test(t);
  if (TEMPLATE.test(t) || !/^[[{]/.test(t)) return false;
  const v = yaml(t);
  return Array.isArray(v) || isRecord(v);
}

/** The same value, whatever the text: a field keeps what was typed while it means this. */
export function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** The line that means `value` again in `valueOfText`, or undefined when it needs several lines. */
export function textOfValue(value: unknown): string | undefined {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') {
    return needsQuotes(value.trim()) ? JSON.stringify(value) : value;
  }
  if (Array.isArray(value) || isRecord(value)) {
    const line = stringify(value, {
      collectionStyle: 'flow',
      flowCollectionPadding: false,
      lineWidth: 0,
    }).trim();
    return line.includes('\n') ? undefined : line;
  }
  return String(value);
}

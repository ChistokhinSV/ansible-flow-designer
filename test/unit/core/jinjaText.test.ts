// AFD-224: Jinja as coloured tokens. Lossless, forgiving of half-typed text, and in agreement with
// the scanner that finds the variables a value reads (core/flow/jinja.ts).
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { exprRefs, parseRefs } from '../../../src/core/flow/jinja';
import { exprMode, type ScanOptions, scanJinja } from '../../../src/core/view/jinjaText';

const T: ScanOptions = { mode: 'template' };
const E: ScanOptions = { mode: 'expr' };
const kinds = (text: string, opts: ScanOptions = T) =>
  scanJinja(text, opts)
    .tokens.filter((t) => t.kind)
    .map((t) => `${t.kind}:${t.text}`);
const joined = (text: string, opts: ScanOptions = T) =>
  scanJinja(text, opts)
    .tokens.map((t) => t.text)
    .join('');

const STAMP = "{{ now(utc=true).strftime('%Y%m%d_%H%M%S') }}";

describe('scanJinja', () => {
  it('colours the real values from a set_fact step', () => {
    expect(kinds(`/var/lib/reports/${STAMP}`)).toEqual([
      'delim:{{',
      'func:now',
      'punct:(',
      'kwarg:utc',
      'op:=',
      'constant:true',
      'punct:)',
      'punct:.',
      'method:strftime',
      'punct:(',
      "string:'",
      'format:%Y',
      'format:%m',
      'format:%d',
      'string:_',
      'format:%H',
      'format:%M',
      'format:%S',
      "string:'",
      'punct:)',
      'delim:}}',
    ]);
  });

  it('names filters, tests, attributes, keywords and numbers', () => {
    expect(kinds("{{ item.name | default('x') ~ 1 if x is not defined else none }}")).toEqual([
      'delim:{{',
      'var:item',
      'punct:.',
      'attr:name',
      'op:|',
      'filter:default',
      'punct:(',
      "string:'x'",
      'punct:)',
      'op:~',
      'number:1',
      'keyword:if',
      'var:x',
      'keyword:is',
      'keyword:not',
      'test:defined',
      'keyword:else',
      'constant:none',
      'delim:}}',
    ]);
  });

  it('reads statements, comments, whitespace control and raw blocks', () => {
    expect(kinds('{%- for h in groups.all if h != x -%}{{ h }}{# note #}{% endfor %}')).toEqual([
      'delim:{%-',
      'keyword:for',
      'var:h',
      'keyword:in',
      'var:groups',
      'punct:.',
      'attr:all',
      'keyword:if',
      'var:h',
      'op:!=',
      'var:x',
      'delim:-%}',
      'delim:{{',
      'var:h',
      'delim:}}',
      'comment:{# note #}',
      'delim:{%',
      'keyword:endfor',
      'delim:%}',
    ]);
    expect(kinds('{% raw %}{{ not jinja }}{% endraw %}')).toEqual([
      'delim:{%',
      'keyword:raw',
      'delim:%}',
      'delim:{% endraw %}',
    ]);
  });

  it('keeps a dict literal open across its closing brace', () => {
    expect(kinds("{{ {'a': 1}}}")).toEqual([
      'delim:{{',
      'punct:{',
      "string:'a'",
      'punct::',
      'number:1',
      'punct:}',
      'delim:}}',
    ]);
  });

  it('reads a bare expression, and a template in a bare field', () => {
    expect(kinds('result.rc == 0 and not failed', E)).toEqual([
      'var:result',
      'punct:.',
      'attr:rc',
      'op:==',
      'number:0',
      'keyword:and',
      'keyword:not',
      'var:failed',
    ]);
    expect(exprMode('x == 1', true)).toBe('expr');
    expect(exprMode('{{ x }} == 1', true)).toBe('template');
    expect(exprMode('x == 1', false)).toBe('template');
  });

  it('reads Jinja quotes as YAML writes them inside a quoted scalar', () => {
    const single = "{{ now().strftime(''%Y'') }}";
    expect(kinds(single, { mode: 'template', yamlQuote: "'" })).toContain("string:''");
    expect(kinds(single, { mode: 'template', yamlQuote: "'" })).toContain('format:%Y');
    const double = '{{ x | default(\\"y\\") }}';
    expect(kinds(double, { mode: 'template', yamlQuote: '"' })).toContain('string:\\"y\\"');
  });

  it('says where half-typed text ends: the open call, argument and string', () => {
    let end = scanJinja("{{ now(utc=true).strftime('%Y", T).end;
    expect(end.where).toBe('expr');
    expect(end.string?.quote).toBe("'");
    expect(end.stack.at(-1)).toMatchObject({ callee: 'strftime', calleeKind: 'method', arg: 0 });
    end = scanJinja("{{ now(fmt='%d", T).end;
    expect(end.stack.at(-1)).toMatchObject({ callee: 'now', kwarg: 'fmt' });
    end = scanJinja("{{ lookup('env', 'HO", T).end;
    expect(end.stack.at(-1)).toMatchObject({ callee: 'lookup', arg: 1 });
    end = scanJinja('text {{ a }} more', T).end;
    expect(end.where).toBe('text');
    end = scanJinja('{% se', T).end;
    expect(end).toMatchObject({ where: 'stmt', stmtWord: 'se', exprStart: 2 });
  });

  it('gives any text back unchanged', () => {
    const pieces = [
      '{{',
      '}}',
      '{%',
      '%}',
      '{#',
      '#}',
      "'",
      '"',
      '(',
      ')',
      '[',
      ']',
      '|',
      '.',
      ' ',
      'x',
      'is',
      'not',
      '1',
      '-',
      '=',
      '%Y',
      '\\',
      '{',
      '}',
      'raw',
      'endraw',
      ',',
    ];
    let seed = 7;
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    for (let n = 0; n < 2000; n++) {
      let s = '';
      const len = Math.floor(rnd() * 20);
      for (let k = 0; k < len; k++) s += pieces[Math.floor(rnd() * pieces.length)];
      for (const opts of [
        T,
        E,
        { mode: 'template', yamlQuote: "'" },
        { mode: 'expr', yamlQuote: '"' },
      ] as ScanOptions[])
        expect(joined(s, opts)).toBe(s);
    }
  });
});

/** Every string in the example and sample flows. */
function flowStrings(): { text: string; bare: boolean }[] {
  const out: { text: string; bare: boolean }[] = [];
  const root = join(__dirname, '../../..');
  const walk = (v: unknown, bare: boolean) => {
    if (typeof v === 'string') out.push({ text: v, bare });
    else if (Array.isArray(v)) for (const x of v) walk(x, bare);
    else if (v && typeof v === 'object')
      for (const [k, x] of Object.entries(v))
        walk(
          x,
          bare || ['condition', 'when', 'until', 'that', 'changed_when', 'failed_when'].includes(k),
        );
  };
  for (const dir of ['examples', 'samples'])
    for (const f of readdirSync(join(root, dir)).filter((f) => f.endsWith('.flow.yaml')))
      walk(parse(readFileSync(join(root, dir, f), 'utf8')), false);
  return out;
}

describe('agrees with the reads scanner', () => {
  it('colours as variables exactly the names the checks read', () => {
    const strings = [
      ...flowStrings(),
      { text: STAMP, bare: false },
      { text: "{{ x | default(y) if z is defined else lookup('env', 'HOME') }}", bare: false },
      { text: 'result.rc == 0 and item.name in allowed', bare: true },
      { text: '{% set n = groups | length %}{{ n + extra }}', bare: false },
    ];
    let checked = 0;
    for (const { text, bare } of strings) {
      if (!/[A-Za-z_]/.test(text)) continue;
      const mode = exprMode(text, bare);
      if (mode === 'template' && !/\{\{|\{%/.test(text)) continue;
      const reads = bare ? exprRefs(text) : parseRefs(text);
      // Names a statement binds are its own: the reads scanner drops them, the colours do not.
      const bound = new Set(
        [...text.matchAll(/\{%-?\s*(?:set|for)\s+([\w\s,]+?)\s*(?:=|\bin\b)/g)].flatMap((m) =>
          (m[1] ?? '').split(',').map((s) => s.trim()),
        ),
      );
      const vars = [
        ...new Set(
          scanJinja(text, { mode })
            .tokens.filter((t) => t.kind === 'var')
            .map((t) => t.text)
            .filter((n) => !bound.has(n)),
        ),
      ];
      expect(vars, text).toEqual(reads);
      checked++;
    }
    expect(checked).toBeGreaterThan(8);
  });
});

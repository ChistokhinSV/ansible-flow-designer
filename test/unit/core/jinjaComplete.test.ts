// AFD-225: what the Jinja completion list offers at the caret, and the signature hint with its
// live date preview. A fixed clock: 2026-11-12 10:15:30.25 UTC.
import { describe, expect, it } from 'vitest';
import type { RefChoice } from '../../../src/core/catalog/draft';
import { isBareParam } from '../../../src/core/flow/keywords';
import { MAGIC_VARS } from '../../../src/core/flow/validate';
import { type CompleteContext, complete, signatureAt } from '../../../src/core/view/jinjaComplete';
import type { ScanOptions } from '../../../src/core/view/jinjaText';
import { MAGIC, strftime } from '../../../src/core/view/jinjaVocabulary';
import { placeMenu } from '../../../src/core/view/menuPlace';

const NOW = new Date(Date.UTC(2026, 10, 12, 10, 15, 30, 250));
const T: ScanOptions = { mode: 'template' };
const version: RefChoice = {
  name: 'version_result',
  label: 'version_result',
  detail: 'from Read version',
  fields: [
    { name: 'stdout', detail: 'What the command printed.' },
    { name: 'rc', detail: 'The exit code.' },
  ],
};
const staged: RefChoice = {
  name: 'target_image',
  label: 'flow.target_image',
  detail: 'flow input',
  field: { type: 'string', from: 'flow.target_image' },
};
const ctx: CompleteContext = { vars: [version, staged], now: NOW };

/** Completion with the caret at `‸` in the text. */
function at(marked: string, opts: ScanOptions = T, c: CompleteContext = ctx) {
  const caret = marked.indexOf('‸');
  const text = marked.slice(0, caret) + marked.slice(caret + 1);
  return complete(text, caret, opts, c);
}
const labels = (marked: string, opts?: ScanOptions) => at(marked, opts)?.items.map((i) => i.label);

describe('complete', () => {
  it("offers strftime's ready formats after now(utc=true).str, each with what it gives now", () => {
    const c = at('{{ now(utc=true).str‸ }}');
    expect(c?.context).toBe('member');
    expect(c?.from).toBe('{{ now(utc=true).'.length);
    expect(c?.to).toBe('{{ now(utc=true).str'.length);
    const stamp = c?.items.find((i) => i.insert === "strftime('%Y%m%d_%H%M%S')");
    expect(stamp?.preview).toBe('20261112_101530');
    expect(c?.items[0]).toMatchObject({
      insert: "strftime('%Y-%m-%d %H:%M:%S')",
      preview: '2026-11-12 10:15:30',
    });
    // The bare method too: the caret goes between its quotes and the codes come next.
    expect(c?.items.find((i) => i.insert === "strftime('')")).toMatchObject({
      caret: 10,
      again: true,
    });
  });

  it('offers the presets, then the codes, inside the format; only codes once one is begun', () => {
    let c = at("{{ now(utc=true).strftime('‸') }}");
    expect(c?.context).toBe('format');
    expect(c?.items[0]?.insert).toBe('%Y-%m-%d %H:%M:%S');
    expect(c?.items.some((i) => i.insert === '%Y')).toBe(true);
    c = at("{{ now(utc=true).strftime('%Y%m%‸') }}");
    expect(c?.from).toBe("{{ now(utc=true).strftime('%Y%m".length);
    expect(c?.items.every((i) => i.insert.startsWith('%'))).toBe(true);
    expect(c?.items.find((i) => i.insert === '%d')?.preview).toBe('12');
    expect(at("{{ now(fmt='%H‸') }}")?.items.map((i) => i.insert)).toEqual(['%H']);
  });

  it('offers filters after |, tests after is and is not', () => {
    expect(labels('{{ x | def‸ }}')?.[0]).toBe('default');
    expect(labels('{{ x |re‸ }}')).toEqual(
      expect.arrayContaining([
        'regex_replace',
        'regex_search',
        'replace',
        'reverse',
        'regex_findall',
      ]),
    );
    expect(labels('{{ x is not def‸ }}')).toEqual(['defined', 'undefined']);
    expect(at('{{ x is ‸')?.context).toBe('test');
  });

  it('offers catalog plugins by their FQCN beside the built-ins', () => {
    const c = at('{{ x | json‸ }}', T, {
      ...ctx,
      filters: [
        {
          name: 'community.general.json_query',
          fqcn: 'community.general.json_query',
          doc: 'Query JSON.',
        },
      ],
    });
    expect(c?.items.map((i) => i.label)).toContain('community.general.json_query');
  });

  it('offers the node’s variables, Ansible’s, the globals and constants where a value starts', () => {
    expect(labels('{{ inv‸ }}')).toEqual([
      'inventory_hostname',
      'inventory_hostname_short',
      'inventory_dir',
      'inventory_file',
    ]);
    expect(labels('{{ no‸ }}')?.slice(0, 5)).toEqual([
      'now()',
      'now(utc=true)',
      "now(fmt='')",
      'none',
      'not',
    ]);
    const c = at('{{ targ‸ }}');
    expect(c?.items[0]).toMatchObject({ insert: 'target_image', choice: staged });
    expect(labels('{{ ‸ }}')?.slice(0, 2)).toEqual(['version_result', 'target_image']);
    expect(labels('result.rc == 0 and ite‸', { mode: 'expr' })).toEqual(['item']);
  });

  it("offers a result's fields, then a field's members by its type", () => {
    expect(labels('{{ version_result.‸ }}')).toEqual(['stdout', 'rc']);
    expect(labels('{{ version_result.stdout.up‸ }}')).toEqual(['upper()']);
    expect(labels("{{ 'a,b'.spl‸ }}")).toEqual(['split()', 'splitlines()', 'rsplit()']);
    expect(labels('{{ (d | to_datetime).ye‸ }}')).toEqual(['year']);
    expect(labels('{{ unknown.‸ }}')).toBeUndefined();
  });

  it('offers lookup names inside lookup() and query()', () => {
    const c = at("{{ lookup('e‸') }}");
    expect(c?.context).toBe('lookup');
    expect(c?.items[0]?.insert).toBe('env');
    expect(c?.from).toBe("{{ lookup('".length);
    expect(labels("{{ query('fi‸")?.slice(0, 3)).toEqual(['file', 'fileglob', 'first_found']);
  });

  it('offers the words that join operands, and statement words', () => {
    expect(labels('{{ x a‸ }}')).toEqual(['and']);
    expect(at('{{ x ‸ }}')).toBeUndefined();
    expect(labels('{% se‸ %}')?.[0]).toBe('set');
    expect(at('{% ‸')?.context).toBe('statement');
  });

  it('offers nothing in plain text or an ordinary string', () => {
    expect(at('path/to/fi‸le')).toBeUndefined();
    expect(at("{{ x | default('ab‸') }}")).toBeUndefined();
    expect(at('{# a no‸ #}')).toBeUndefined();
  });
});

describe('signatureAt', () => {
  it('names the call and argument the caret is in, with a live format preview', () => {
    const text = "{{ now(utc=true).strftime('%Y%m%d_%H%M%S') }}";
    expect(signatureAt(text, '{{ now('.length, T, { now: NOW })).toMatchObject({
      label: 'now(utc=False, fmt=None)',
      arg: 0,
    });
    const hint = signatureAt(text, text.indexOf('%M'), T, { now: NOW });
    expect(hint).toMatchObject({ label: 'strftime(format)', preview: '20261112_101530' });
    expect(signatureAt("{{ x | default('a', ", 22, T)).toMatchObject({ arg: 1 });
    expect(signatureAt('{{ x }}', 3, T)).toBeUndefined();
  });
});

describe('strftime', () => {
  it("gives Python's results", () => {
    const d = new Date(Date.UTC(2026, 10, 12, 10, 15, 30, 250));
    expect(strftime('%a %A %b %B %j %U %W %V %G %u %w %I %p %y %f', d, true)).toBe(
      'Thu Thursday Nov November 316 45 45 46 2026 4 4 10 AM 26 250000',
    );
    expect(strftime('%c|%x|%X|%Y-%m-%dT%H:%M:%S|%%|%z', d, true)).toBe(
      'Thu Nov 12 10:15:30 2026|11/12/26|10:15:30|2026-11-12T10:15:30|%|',
    );
    expect(strftime('%-d/%-m %_H %^a', d, true)).toBe('12/11 10 THU');
    expect(strftime('%j %U %W %V %G %u %w %I %p', new Date(Date.UTC(2027, 0, 1)), true)).toBe(
      '001 00 00 53 2026 5 5 12 AM',
    );
    expect(
      strftime('%j %U %W %V %G %u %w %I %p', new Date(Date.UTC(2024, 11, 30, 23, 5)), true),
    ).toBe('365 52 53 01 2025 1 1 11 PM');
  });
});

describe('bare-expression parameters (AFD-227)', () => {
  it('knows assert that and debug var', () => {
    expect(isBareParam('ansible.builtin.assert', 'that')).toBe(true);
    expect(isBareParam('assert', 'that')).toBe(true);
    expect(isBareParam('ansible.builtin.debug', 'var')).toBe(true);
    expect(isBareParam('ansible.builtin.debug', 'msg')).toBe(false);
  });
});

describe('vocabulary', () => {
  it('names only variables the checks know as Ansible’s', () => {
    for (const w of MAGIC) expect(MAGIC_VARS.test(w.name), w.name).toBe(true);
  });
});

describe('placeMenu (AFD-226)', () => {
  const view = { width: 1000, height: 700 };
  const menu = { width: 300, height: 200 };
  it('goes under the caret line, moved left to stay in the window', () => {
    expect(
      placeMenu({ left: 400, top: 100, bottom: 118 }, { left: 350, top: 90 }, menu, view),
    ).toEqual({
      left: 50,
      top: 30,
      above: false,
    });
    expect(
      placeMenu({ left: 900, top: 100, bottom: 118 }, { left: 850, top: 90 }, menu, view).left,
    ).toBe(696 - 850);
  });
  it('goes above the line when there is no room below', () => {
    expect(
      placeMenu({ left: 100, top: 600, bottom: 618 }, { left: 100, top: 590 }, menu, view),
    ).toEqual({
      left: 0,
      top: 600 - 590 - 2 - 200,
      above: true,
    });
  });
});

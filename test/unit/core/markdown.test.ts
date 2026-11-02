// AFD-64: the Markdown of annotations: plain parts, never HTML; only web links are links.
import { describe, expect, it } from 'vitest';
import {
  linksOf,
  markdownHtml,
  parseInline,
  parseMarkdown,
  plainText,
} from '../../../src/core/view/markdown';

describe('annotation Markdown (AFD-64)', () => {
  it('paragraphs, lists, bold, italic, code and links', () => {
    expect(
      parseMarkdown(
        'Drain **first**, *then* `reload`.\n\n- one\n- [wiki](https://wiki.example.net/x)',
      ),
    ).toEqual([
      {
        kind: 'para',
        parts: [
          { kind: 'text', text: 'Drain ' },
          { kind: 'bold', text: 'first' },
          { kind: 'text', text: ', ' },
          { kind: 'italic', text: 'then' },
          { kind: 'text', text: ' ' },
          { kind: 'code', text: 'reload' },
          { kind: 'text', text: '.' },
        ],
      },
      {
        kind: 'list',
        items: [
          [{ kind: 'text', text: 'one' }],
          [{ kind: 'link', text: 'wiki', href: 'https://wiki.example.net/x' }],
        ],
      },
    ]);
  });

  it('only http(s) links are links; a bare URL stops before trailing punctuation', () => {
    expect(parseInline('[x](javascript:void)')).toEqual([{ kind: 'text', text: 'x' }]);
    expect(parseInline('see https://runbook.example.net/edge.')).toEqual([
      { kind: 'text', text: 'see ' },
      {
        kind: 'link',
        text: 'https://runbook.example.net/edge',
        href: 'https://runbook.example.net/edge',
      },
      { kind: 'text', text: '.' },
    ]);
    expect(linksOf('[a](command:afd.run.real) and [b](https://a.example.net)')).toEqual([
      'https://a.example.net',
    ]);
  });

  it('plain text for comments and agents; escaped HTML for draw.io', () => {
    expect(plainText('**Safe** to rerun\n- [wiki](https://w.example.net)')).toBe(
      'Safe to rerun\n- wiki (https://w.example.net)',
    );
    expect(markdownHtml('<script>x</script> **b** & [l](https://e.example.net/?a=1&b=2)')).toBe(
      '<div>&lt;script&gt;x&lt;/script&gt; <b>b</b> &amp; <a href="https://e.example.net/?a=1&amp;b=2">l</a></div>',
    );
  });
});

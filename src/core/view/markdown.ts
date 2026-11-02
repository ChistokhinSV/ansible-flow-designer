// The Markdown of annotations (AFD-64): paragraphs, `- ` bullet lists, **bold**, *italic*, `code`,
// [links](https://...) and bare http(s) URLs. Parsed into plain parts, never HTML: the webview makes
// text nodes of them, code comments and agents get plain text, draw.io an escaped subset.

export type Inline =
  | { kind: 'text' | 'bold' | 'italic' | 'code'; text: string }
  | { kind: 'link'; text: string; href: string };

export type Block = { kind: 'para'; parts: Inline[] } | { kind: 'list'; items: Inline[][] };

/** Only web links are links; anything else (javascript:, file:, command:) stays text. */
export const isWebLink = (href: string): boolean => /^https?:\/\/[^\s<>"]+$/i.test(href);

const TOKEN =
  /`([^`\n]+)`|\*\*([^*\n]+?)\*\*|\*([^*\n]+?)\*|\[([^\]\n]+)\]\(([^)\s]+)\)|(https?:\/\/[^\s<>"()[\]]*[^\s<>"()[\].,;:!?'])/g;

export function parseInline(line: string): Inline[] {
  const out: Inline[] = [];
  const text = (t: string) => {
    if (!t) return;
    const last = out.at(-1);
    if (last?.kind === 'text') last.text += t;
    else out.push({ kind: 'text', text: t });
  };
  let at = 0;
  for (const m of line.matchAll(TOKEN)) {
    text(line.slice(at, m.index));
    at = (m.index ?? 0) + m[0].length;
    if (m[1] !== undefined) out.push({ kind: 'code', text: m[1] });
    else if (m[2] !== undefined) out.push({ kind: 'bold', text: m[2] });
    else if (m[3] !== undefined) out.push({ kind: 'italic', text: m[3] });
    else if (m[4] !== undefined && m[5] !== undefined)
      if (isWebLink(m[5])) out.push({ kind: 'link', text: m[4], href: m[5] });
      else text(m[4]);
    else if (m[6] !== undefined) out.push({ kind: 'link', text: m[6], href: m[6] });
  }
  text(line.slice(at));
  return out;
}

const BULLET = /^\s*[-*]\s+/;

export function parseMarkdown(text: string): Block[] {
  const blocks: Block[] = [];
  let para: string[] = [];
  let list: Inline[][] | undefined;
  const endPara = () => {
    if (para.length) blocks.push({ kind: 'para', parts: parseInline(para.join('\n')) });
    para = [];
  };
  const endList = () => {
    if (list) blocks.push({ kind: 'list', items: list });
    list = undefined;
  };
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    if (BULLET.test(raw)) {
      endPara();
      list ??= [];
      list.push(parseInline(raw.replace(BULLET, '')));
    } else if (raw.trim() === '') {
      endPara();
      endList();
    } else {
      endList();
      para.push(raw);
    }
  }
  endPara();
  endList();
  return blocks;
}

const flat = (parts: Inline[]) =>
  parts
    .map((p) => (p.kind === 'link' && p.text !== p.href ? `${p.text} (${p.href})` : p.text))
    .join('');

/** The words without Markdown: for code comments, agents and pictures. */
export function plainText(text: string): string {
  return parseMarkdown(text)
    .map((b) => (b.kind === 'para' ? flat(b.parts) : b.items.map((i) => `- ${flat(i)}`).join('\n')))
    .join('\n');
}

/** Every web link of a text: what the host may open from it. */
export function linksOf(text: string): string[] {
  return parseMarkdown(text).flatMap((b) =>
    (b.kind === 'para' ? b.parts : b.items.flat()).flatMap((p) =>
      p.kind === 'link' ? [p.href] : [],
    ),
  );
}

const escapeHtml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** An escaped HTML subset (b, i, code, a, ul/li, br) for draw.io labels. */
export function markdownHtml(text: string): string {
  const inline = (parts: Inline[]) =>
    parts
      .map((p) => {
        const t = escapeHtml(p.text).replace(/\n/g, '<br>');
        if (p.kind === 'bold') return `<b>${t}</b>`;
        if (p.kind === 'italic') return `<i>${t}</i>`;
        if (p.kind === 'code') return `<code>${t}</code>`;
        if (p.kind === 'link') return `<a href="${escapeHtml(p.href)}">${t}</a>`;
        return t;
      })
      .join('');
  return parseMarkdown(text)
    .map((b) =>
      b.kind === 'para'
        ? `<div>${inline(b.parts)}</div>`
        : `<ul>${b.items.map((i) => `<li>${inline(i)}</li>`).join('')}</ul>`,
    )
    .join('');
}

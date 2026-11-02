// An annotation's Markdown as React text nodes (AFD-65): the parts of core/view/markdown, never
// HTML. A link click asks the host to open it; the host opens only web links of this flow.
import { Fragment, type MouseEvent } from 'react';
import { type Inline, parseMarkdown } from '../../core/view/markdown';
import { send } from '../bus';

function open(e: MouseEvent, href: string) {
  e.preventDefault();
  e.stopPropagation();
  send({ type: 'openLink', url: href });
}

function Parts({ parts }: { parts: Inline[] }) {
  return (
    <>
      {parts.map((p, i) => {
        const key = `${i}-${p.kind}`;
        const text = p.text.split('\n').map((line, j) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: lines of one text, in order
          <Fragment key={j}>
            {j > 0 ? <br /> : null}
            {line}
          </Fragment>
        ));
        if (p.kind === 'bold') return <strong key={key}>{text}</strong>;
        if (p.kind === 'italic') return <em key={key}>{text}</em>;
        if (p.kind === 'code') return <code key={key}>{p.text}</code>;
        if (p.kind === 'link')
          return (
            <a
              key={key}
              href={p.href}
              className="nodrag"
              title={p.href}
              onClick={(e) => open(e, p.href)}
              onDoubleClick={(e) => e.stopPropagation()}
            >
              {p.text}
            </a>
          );
        return <Fragment key={key}>{text}</Fragment>;
      })}
    </>
  );
}

export function MarkdownView({ text }: { text: string }) {
  return (
    <>
      {parseMarkdown(text).map((b, i) =>
        b.kind === 'para' ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: blocks of one text, in order
          <p key={i}>
            <Parts parts={b.parts} />
          </p>
        ) : (
          // biome-ignore lint/suspicious/noArrayIndexKey: blocks of one text, in order
          <ul key={i}>
            {b.items.map((item, j) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: items of one list, in order
              <li key={j}>
                <Parts parts={item} />
              </li>
            ))}
          </ul>
        ),
      )}
    </>
  );
}

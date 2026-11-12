// The Jinja completion list and its help (AFD-226), shared by chip fields and the YAML box: the
// list with the active item's signature, doc and date preview under it; the hint row with the
// arguments of the call the caret is in; the tooltip a name shows on hover. The fields own the
// text, the caret and the keys; these draw what core/view/jinjaComplete gives them.
import {
  type CSSProperties,
  Fragment,
  forwardRef,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import type { RefChoice } from '../../core/catalog/draft';
import type {
  CompleteContext,
  Completion,
  CompletionItem,
  Description,
  ItemKind,
  SignatureHint,
} from '../../core/view/jinjaComplete';
import { usePluginNames } from '../catalog';

const ICONS: Record<ItemKind, string> = {
  variable: 'symbol-variable',
  function: 'symbol-method',
  method: 'symbol-method',
  field: 'symbol-field',
  filter: 'filter',
  test: 'beaker',
  lookup: 'search',
  keyword: 'symbol-keyword',
  format: 'calendar',
};

const HEADS: Record<Completion['context'], string> = {
  value: 'Variables and functions',
  filter: 'Filters',
  test: 'Tests',
  member: 'Members',
  format: 'Date formats',
  lookup: 'Lookups',
  statement: 'Statements',
  operator: 'Operators',
};

/** What a field's completion knows besides its text: its variables and the environment's plugins. */
export function useJinjaContext(choices: readonly RefChoice[]): CompleteContext {
  const plugins = usePluginNames();
  return { vars: choices, ...plugins };
}

/** A signature with the argument the caret is in shown strong. */
function signature(label: string, arg: number): ReactNode {
  const open = label.indexOf('(');
  const close = label.lastIndexOf(')');
  if (open < 0 || close < open) return label;
  const args = label.slice(open + 1, close).split(/,\s*/);
  return (
    <>
      {label.slice(0, open + 1)}
      {args.map((a, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: arguments are positional.
        <Fragment key={i}>
          {i > 0 ? ', ' : ''}
          {i === arg ? <strong>{a}</strong> : a}
        </Fragment>
      ))}
      {label.slice(close)}
    </>
  );
}

export const CompletionList = forwardRef<
  HTMLDivElement,
  {
    id: string;
    completion: Completion;
    active: number;
    onPick(item: CompletionItem): void;
    style?: CSSProperties;
  }
>(function CompletionList({ id, completion, active, onPick, style }, ref) {
  const item = completion.items[active];
  return (
    <div
      ref={ref}
      className="afd-jinja-popup"
      style={style}
      data-jinja-context={completion.context}
    >
      <div
        className="afd-ref-menu afd-jinja-menu"
        role="listbox"
        id={id}
        aria-label={HEADS[completion.context]}
      >
        {completion.items.map((it, i) => (
          <div
            // biome-ignore lint/suspicious/noArrayIndexKey: the same label can come twice (now()).
            key={`${it.label}|${i}`}
            id={`${id}-${i}`}
            role="option"
            tabIndex={-1}
            aria-selected={i === active}
            className={i === active ? 'active' : ''}
            onMouseDown={(e) => {
              // The field keeps the focus and its caret.
              e.preventDefault();
              onPick(it);
            }}
          >
            <span className={`codicon codicon-${ICONS[it.kind]}`} aria-hidden="true" />
            <span className="mono afd-jinja-label">{it.label}</span>
            {it.preview !== undefined ? (
              <span className="mono afd-jinja-preview">→ {it.preview || '(empty)'}</span>
            ) : it.detail ? (
              <span className="muted">{it.detail}</span>
            ) : null}
          </div>
        ))}
      </div>
      {item && (item.sig || item.doc) ? (
        <div className="afd-jinja-doc" aria-live="polite">
          {item.sig ? <div className="mono">{item.sig}</div> : null}
          {item.doc ? <div className="muted">{item.doc}</div> : null}
        </div>
      ) : null}
    </div>
  );
});

/** The call the caret is in: its arguments, the one being typed strong, and a date's preview. */
export function SignatureRow({ hint }: { hint: SignatureHint }) {
  return (
    <div className="afd-jinja-hint" data-jinja-hint>
      <span className="mono">{signature(hint.label, hint.arg)}</span>
      {hint.preview !== undefined ? (
        <span className="mono afd-jinja-preview"> → {hint.preview || '(empty)'}</span>
      ) : null}
      {hint.doc ? <span className="muted"> {hint.doc}</span> : null}
    </div>
  );
}

export function JinjaTip({ tip, style }: { tip: Description; style?: CSSProperties }) {
  return (
    <div className="afd-jinja-tip" role="tooltip" style={style}>
      <div className="mono">{tip.label}</div>
      {tip.doc ? <div className="muted">{tip.doc}</div> : null}
      {tip.preview !== undefined ? (
        <div className="mono afd-jinja-preview">→ {tip.preview || '(empty)'}</div>
      ) : null}
    </div>
  );
}

/** The list's keys (AFD-226). Returns whether the key was the list's; the field ignores it then. */
export function listKey(
  e: KeyboardEvent,
  open: { count: number; active: number } | null,
  act: { move(active: number): void; pick(): void; close(): void; force(): void },
): boolean {
  if (e.nativeEvent.isComposing || e.keyCode === 229) return false;
  const stop = () => {
    e.preventDefault();
    e.stopPropagation();
  };
  if (e.key === ' ' && e.ctrlKey && !e.altKey && !e.metaKey) {
    stop();
    act.force();
    return true;
  }
  if (!open || open.count === 0) return false;
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    stop();
    const step = e.key === 'ArrowDown' ? 1 : open.count - 1;
    act.move((open.active + step) % open.count);
    return true;
  }
  if ((e.key === 'Enter' || e.key === 'Tab') && !e.shiftKey && !e.ctrlKey && !e.altKey) {
    stop();
    act.pick();
    return true;
  }
  if (e.key === 'Escape') {
    stop();
    act.close();
    return true;
  }
  return false;
}

/** Whether typing `data` should open the list by itself (as VS Code's suggestions do). */
export function opensList(
  data: string | null | undefined,
  completion: Completion | undefined,
): boolean {
  const ch = data?.slice(-1);
  if (!ch || !completion) return false;
  if (/[A-Za-z0-9_.|'"%({]/.test(ch)) return true;
  return ch === ' ' && (completion.context === 'test' || completion.context === 'filter');
}

/**
 * The text a pick puts in (AFD-226): with ` }}` when it starts a template that is not closed yet,
 * so `{{ inv` becomes `{{ inventory_hostname }}`.
 */
export function pickText(
  value: string,
  completion: Completion,
  item: CompletionItem,
  template: boolean,
): { text: string; caret: number } {
  const caret = item.caret ?? item.insert.length;
  const after = value.slice(completion.to).split('{{')[0] ?? '';
  const opened = /\{\{(?![\s\S]*\}\})[\s\S]*$/.test(value.slice(0, completion.from));
  if (
    template &&
    opened &&
    !after.includes('}}') &&
    completion.context !== 'format' &&
    completion.context !== 'lookup'
  )
    return { text: `${item.insert} }}`, caret };
  return { text: item.insert, caret };
}

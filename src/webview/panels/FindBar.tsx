// Find a node (AFD-48), Ctrl+F: one box over the canvas that searches every level by title, key or
// binding. The arrow keys move through the results and Enter shows one, opening its level; the box
// stays open, so the next result is one more key away. What is typed lives in the store: the
// canvas is remade for each level, and the box with it.
import { useEffect, useMemo, useRef, useState } from 'react';
import { findNodes } from '../../core/view/find';
import { TYPE_LABEL } from '../constants';
import { useModel } from '../hooks';
import { useUi } from '../store';

const NOTE_LABEL = { note: 'Note', section: 'Section', text: 'Text' } as const;

const LIMIT = 50;

export function FindBar() {
  const open = useUi((s) => s.find);
  return open ? <Find /> : null;
}

function Find() {
  const model = useModel();
  const query = useUi((s) => s.findQuery);
  const nonce = useUi((s) => s.findNonce);
  const input = useRef<HTMLInputElement>(null);
  const results = useMemo(() => (model ? findNodes(model, query, LIMIT) : []), [model, query]);
  // The node shown last stays the current result when the box comes back on another level.
  const [active, setActive] = useState(() =>
    Math.max(
      0,
      results.findIndex((r) => r.id === useUi.getState().selection.node),
    ),
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: Ctrl+F again (a new nonce) selects what is typed
  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, [nonce]);

  const show = (i: number) => {
    const r = results[i];
    if (!r) return;
    setActive(i);
    useUi.getState().reveal(r.id);
  };
  const close = () => {
    const node = useUi.getState().selection.node;
    useUi.getState().openFind(false);
    // The node found keeps the focus, so Enter goes on into its Details.
    setTimeout(() =>
      document.querySelector<HTMLElement>(`.react-flow__node[data-id="${node}"]`)?.focus(),
    );
  };
  const current = results[active];

  return (
    <search className="afd-find nodrag nopan nowheel" data-find={results.length}>
      <div className="afd-find-row">
        <span className="codicon codicon-search" aria-hidden="true" />
        <input
          ref={input}
          className="afd-input"
          role="combobox"
          aria-label="Find a node"
          aria-expanded={results.length > 0}
          aria-controls="afd-find-results"
          aria-autocomplete="list"
          aria-activedescendant={current ? `afd-find-${current.id}` : undefined}
          placeholder="Title, key or module"
          value={query}
          onChange={(e) => {
            useUi.getState().setFindQuery(e.target.value);
            setActive(0);
          }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
              e.preventDefault();
              const step = e.key === 'ArrowDown' ? 1 : -1;
              if (results.length) setActive((active + step + results.length) % results.length);
            } else if (e.key === 'Enter') {
              e.preventDefault();
              show(e.shiftKey ? (active - 1 + results.length) % results.length : active);
            } else if (e.key === 'Escape') {
              e.preventDefault();
              e.stopPropagation();
              close();
            }
          }}
        />
        <span className="muted afd-find-count" aria-live="polite">
          {query.trim()
            ? `${results.length === LIMIT ? `${LIMIT}+` : results.length} found`
            : 'every level'}
        </span>
        <button
          type="button"
          className="icon"
          aria-label="Close Find"
          title="Close (Esc)"
          onClick={close}
        >
          <span className="codicon codicon-close" aria-hidden="true" />
        </button>
      </div>
      {query.trim() && results.length ? (
        <div
          id="afd-find-results"
          role="listbox"
          aria-label="Nodes found"
          className="afd-find-results"
        >
          {results.map((r, i) => (
            // biome-ignore lint/a11y/useKeyWithClickEvents lint/a11y/useFocusableInteractive: the combobox owns the keys and the focus (aria-activedescendant)
            <div
              key={r.id}
              id={`afd-find-${r.id}`}
              role="option"
              aria-selected={i === active}
              className={i === active ? 'active' : ''}
              data-found={r.id}
              // Keep the focus in the box: a click shows the node, typing goes on.
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => show(i)}
            >
              <span className="afd-find-title">{r.title}</span>
              <span className="muted">
                {[...r.trail, r.annotation ? NOTE_LABEL[r.annotation] : TYPE_LABEL[r.type]].join(
                  ' › ',
                )}
                {r.ref ? ` · ${r.ref}` : ''}
              </span>
            </div>
          ))}
        </div>
      ) : null}
    </search>
  );
}

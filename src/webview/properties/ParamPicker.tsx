// The parameter picker (AFD-80): a search box over the module's other parameters, each with what it
// does, in place of a native select of bare names (round 1: P1 looked `line` and `state` up on the
// web). The ARIA combobox pattern with a listbox popup: typing, a click or Down opens it, arrows
// move, Enter adds the parameter to Configure, Escape closes.
import { type KeyboardEvent, useId, useState } from 'react';
import { type FormField, filterParams } from '../../core/catalog/draft';

export function ParamPicker({
  fields,
  onPick,
}: {
  fields: FormField[];
  onPick(name: string): void;
}) {
  const id = useId();
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const shown = open ? filterParams(fields, query) : [];
  const at = Math.min(active, Math.max(0, shown.length - 1));
  const list = `${id}-list`;
  const option = (i: number) => `${id}-opt-${i}`;
  const pick = (f: FormField | undefined) => {
    if (!f) return;
    setQuery('');
    setOpen(false);
    setActive(0);
    onPick(f.name);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!open) return setOpen(true);
      const n = shown.length;
      if (n > 0) setActive((at + (e.key === 'ArrowDown' ? 1 : n - 1)) % n);
    } else if (e.key === 'Enter' && open) {
      e.preventDefault();
      pick(shown[at]);
    } else if (e.key === 'Escape' && open) {
      e.preventDefault();
      e.stopPropagation();
      setOpen(false);
    }
  };
  return (
    <div className="afd-field afd-param-picker" data-param-picker={fields.length}>
      <label htmlFor={id}>Add a parameter</label>
      <div className="afd-chipfield">
        <input
          id={id}
          className="afd-input"
          role="combobox"
          aria-expanded={open}
          aria-controls={list}
          aria-autocomplete="list"
          aria-activedescendant={open && shown[at] ? option(at) : undefined}
          placeholder={`${fields.length} more: a name or what it does`}
          value={query}
          autoComplete="off"
          spellCheck={false}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
            setActive(0);
          }}
          onClick={() => setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 150)}
          onKeyDown={onKeyDown}
        />
        {open ? (
          <div
            id={list}
            className="afd-ref-menu afd-param-list"
            role="listbox"
            aria-label="Parameters"
          >
            {shown.length === 0 ? (
              <div className="muted">No parameter matches “{query.trim()}”.</div>
            ) : (
              shown.map((f, i) => (
                <div
                  key={f.name}
                  id={option(i)}
                  role="option"
                  tabIndex={-1}
                  aria-selected={i === at}
                  className={i === at ? 'active' : ''}
                  data-param-option={f.name}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    pick(f);
                  }}
                >
                  <span className="mono">{f.name}</span>
                  <span className="muted">{f.option.type}</span>
                  <span className="afd-param-desc">{f.option.description.split('\n')[0]}</span>
                </div>
              ))
            )}
          </div>
        ) : null}
      </div>
    </div>
  );
}

// Quick add (04 §4, mockup 02): context, type, title (→ key), intent, inputs suggested from the
// upstream node's outputs, preset optional ports, and "wire failed_hosts to the existing Rollback".
// AFD-232: the Title field also finds what the step runs. As you type it lists the step types,
// modules and roles that match (and, while it is empty, what this flow already uses); Enter alone
// still adds a step with the title typed, a pick from the list makes the step bound to it. AFD-328:
// typed as a module's or role's own name ("ping"), Enter picks that module or role.
import {
  type FormEvent,
  type KeyboardEvent,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react';
import { slugify, uniqueKey } from '../../core/flow/ids';
import { modelOf, ROOT } from '../../core/flow/model';
import { findRollback } from '../../core/flow/patterns';
import { offeredPortNames, portsFor } from '../../core/flow/ports';
import { type ContractField, NODE_TYPES, type NodeType } from '../../core/flow/types';
import { portHint } from '../../core/view/portHints';
import {
  defaultPick,
  type Suggestion,
  suggestSteps,
  titleAfterPick,
  titleFor,
  usedBindings,
} from '../../core/view/quickAdd';
import { run } from '../actions';
import { useCatalog } from '../catalog';
import { TYPE_LABEL } from '../constants';
import { useDialogFocus } from '../focus';
import { useUi } from '../store';
import { levelView, unplacedPositions } from '../viewModel';
import { Fold } from './Fold';

/** Types that can sit on a wire: they have an input and continue on an output. */
/** What a wire can take in its middle (Insert Node on This Wire; AFD-88: a drop on a wire). */
export const INSERTABLE: readonly NodeType[] = [
  'task',
  'subflow',
  'decision',
  'approval',
  'parallel',
  'join',
];

export function QuickAdd() {
  const open = useUi((s) => s.quickAdd !== null);
  return open ? <QuickAddDialog /> : null;
}

/** Mounted while open, so its focus goes back to what opened it (AFD-47). */
function QuickAddDialog() {
  const quick = useUi((s) => s.quickAdd);
  const snapshot = useUi((s) => s.snapshot);
  const close = useUi((s) => s.openQuickAdd);
  const select = useUi((s) => s.select);
  const [type, setType] = useState<NodeType>('task');
  const [title, setTitle] = useState('');
  // AFD-316: the add is on its way; the button says so and is not pressed twice.
  const [adding, setAdding] = useState(false);
  const [intent, setIntent] = useState('');
  const [ports, setPorts] = useState<string[]>([]);
  const [inputs, setInputs] = useState<string[]>([]);
  const [wireRollback, setWireRollback] = useState(true);
  // AFD-232: what the step runs, picked from the list under the title; the row the arrows are on.
  const [bound, setBound] = useState<{ kind: 'module' | 'role'; ref: string } | null>(null);
  const [typed, setTyped] = useState(false);
  // AFD-334: the title was changed after a pick: the list searches again, the pick kept first.
  const [retitled, setRetitled] = useState(false);
  // The row the arrows are on; null until they move it (Enter then takes an exact match).
  const [active, setActive] = useState<number | null>(null);
  const listId = useId();
  const titleRef = useRef<HTMLInputElement>(null);
  const box = useRef<HTMLFormElement>(null);
  const trap = useDialogFocus(box);

  useEffect(() => {
    if (!quick) return;
    setType(quick.type);
    setTitle(quick.title ?? '');
    setIntent('');
    setPorts([]);
    setInputs([]);
    // AFD-334: wired to Rollback only when the step is added after or between steps; a step added
    // on its own (palette, nothing selected) is not wired unasked.
    setWireRollback(!!(quick.connectFrom || quick.insertOn));
    setBound(null);
    setTyped(false);
    setRetitled(false);
    setActive(null);
    setTimeout(() => titleRef.current?.focus(), 0);
  }, [quick]);

  const model = useMemo(() => (snapshot?.doc ? modelOf(snapshot.doc) : undefined), [snapshot]);
  const levelId = useUi((s) => s.level);
  // A prefilled title (Cleanup Task) is a name, not a search: the list waits for typing.
  const searching = !bound || retitled;
  const query = typed && searching ? title.trim() : '';
  const finds = type === 'task' && searching;
  const hits = useCatalog(
    finds && query.length >= 2 ? { op: 'search', query, types: ['module'] } : null,
    `quick-add:${finds ? query : ''}`,
    200,
  );
  const roles = useCatalog(
    finds && typed ? { op: 'roles' } : null,
    `quick-add-roles:${finds && typed}`,
  );
  const used = useMemo(() => (model ? usedBindings(model) : []), [model]);
  if (!quick || !model) return null;
  // Undefined inside a subflow that has no inner steps yet (the new node creates the level).
  const level = model.levels.get(levelId);
  const insertEdge = quick.insertOn ? model.edges.get(quick.insertOn)?.edge : undefined;
  const sourceRef = quick.connectFrom ?? insertEdge?.from;
  const source = sourceRef ? model.nodes.get(sourceRef.node)?.node : undefined;
  const next = insertEdge ? model.nodes.get(insertEdge.to.node)?.node : undefined;
  const taken = new Set(level?.nodes.map((n) => n?.key));
  const key = uniqueKey(slugify(title || TYPE_LABEL[type]), taken);
  const rollback = level ? findRollback(level) : undefined;
  const canFail = portsFor({ type }).some((p) => p.name === 'failed_hosts');
  const suggested = Object.entries(source?.outputs ?? {});
  const allowed = NODE_TYPES.filter((t) =>
    quick.insertOn ? INSERTABLE.includes(t) : !quick.connectFrom || t !== 'start',
  );
  const found: Suggestion[] = searching
    ? suggestSteps({
        query: typed ? title.trim() : '',
        type,
        types: allowed.map((t) => ({ type: t, label: TYPE_LABEL[t] })),
        modules: hits.data ?? [],
        roles: (roles.data ?? []).map((r) => r.name),
        used,
      })
    : [];
  const keep: Suggestion[] =
    bound && retitled && type === 'task'
      ? [
          {
            kind: bound.kind,
            ref: bound.ref,
            label: `Keep ${bound.ref}`,
            hint: 'what the step runs now',
          },
        ]
      : [];
  const suggestions: Suggestion[] = [
    ...keep,
    ...found.filter(
      (s) =>
        !keep.some(
          (k) => s.kind !== 'type' && k.kind !== 'type' && s.kind === k.kind && s.ref === k.ref,
        ),
    ),
  ];
  // AFD-328, AFD-334: the exact match, else the first module or role, is highlighted and Enter
  // picks it; the arrows move off it (up from the first row: the step as typed).
  const at =
    active === null
      ? defaultPick(suggestions, typed ? title : '')
      : active < suggestions.length
        ? active
        : -1;
  const choose = (s: Suggestion) => {
    setActive(null);
    setRetitled(false);
    if (s.kind === 'type') {
      setType(s.type);
      setPorts([]);
      setBound(null);
      setTitle('');
      setTyped(false);
    } else if (bound && s.kind === bound.kind && s.ref === bound.ref) {
      // Kept: the title stays as now typed.
    } else {
      setType('task');
      setPorts([]);
      setBound({ kind: s.kind, ref: s.ref });
      // AFD-328: a title typed as a name stays; a search gives way to one made from the pick.
      setTitle(typed ? titleAfterPick(title, s.ref) : titleFor(s.ref));
      // The title is selected: typing replaces it, Enter keeps it.
      setTimeout(() => titleRef.current?.select(), 0);
    }
    titleRef.current?.focus();
  };
  const onTitleKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (suggestions.length === 0) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const step = e.key === 'ArrowDown' ? 1 : -1;
      // From the last row, and up from the first, back to the field: Enter adds what is typed.
      const next = at + step;
      setActive(next >= suggestions.length || next < -1 ? -1 : next);
    } else if (e.key === 'Enter' && at >= 0) {
      e.preventDefault();
      choose(suggestions[at] as Suggestion);
    }
  };

  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    if (!title.trim() || adding) return;
    const chosen: Record<string, ContractField> = {};
    for (const name of inputs) {
      const out = source?.outputs?.[name];
      chosen[name] = { type: out?.type ?? 'any', from: `${source?.key}.${name}` };
    }
    const snap = useUi.getState().snapshot;
    // Nodes still at auto-layout positions are written too, so the new node does not move them.
    const freeze =
      snap?.doc && quick.position
        ? {
            ...unplacedPositions(
              levelView(snap, useUi.getState().optimistic, levelId),
              snap.doc.layout,
            ),
            ...quick.makeRoom,
          }
        : undefined;
    setAdding(true);
    const ack = await run({
      kind: 'addNode',
      parent: levelId === ROOT ? undefined : levelId,
      type,
      title: title.trim(),
      intent: intent.trim() || undefined,
      ports,
      inputs: chosen,
      ...(bound && type === 'task' ? { impl: bound } : {}),
      position: quick.position,
      connectFrom: quick.connectFrom,
      insertOn: quick.insertOn,
      freeze,
      wireFailedTo: canFail && wireRollback && rollback ? rollback.id : undefined,
    });
    setAdding(false);
    if (ack.ok) {
      close(null);
      if (ack.created) {
        select({ node: ack.created });
        // AFD-328: never left off view or under the zoom controls.
        useUi.setState({ bringIntoView: ack.created });
      }
    }
  };

  return (
    <div className="afd-modal-backdrop">
      <form
        ref={box}
        className="afd-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="afd-qa-title"
        onSubmit={submit}
        onKeyDown={(e) => {
          trap(e);
          // Only this dialog closes: the page behind it (Properties) stays open.
          if (e.key !== 'Escape') return;
          e.stopPropagation();
          close(null);
        }}
      >
        <h2 id="afd-qa-title">Add Node</h2>
        <p className="muted">
          {source && insertEdge ? (
            <>
              Between <strong>{source.title}</strong> ·{' '}
              <span className="mono">{insertEdge.from.port}</span> and{' '}
              <strong>{next?.title}</strong>
            </>
          ) : source && quick.connectFrom ? (
            <>
              After <strong>{source.title}</strong>, from port{' '}
              <span className="mono">{quick.connectFrom.port}</span>
            </>
          ) : (
            'New draft node on the canvas'
          )}
        </p>
        <fieldset className="afd-type-picker" aria-label="Node type">
          {allowed.map((t) => (
            <button
              key={t}
              type="button"
              aria-pressed={type === t}
              className={type === t ? 'active' : ''}
              onClick={() => {
                setType(t);
                setPorts([]);
                if (t !== 'task') setBound(null);
              }}
            >
              {TYPE_LABEL[t]}
            </button>
          ))}
        </fieldset>
        <div className="afd-field">
          <label htmlFor="afd-qa-name">Title</label>
          <input
            id="afd-qa-name"
            ref={titleRef}
            className="afd-input"
            value={title}
            placeholder={type === 'task' ? 'A name, or a module or role to find' : 'e.g. Check NTP'}
            role="combobox"
            aria-expanded={suggestions.length > 0}
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={at >= 0 ? `${listId}-${at}` : undefined}
            autoComplete="off"
            onChange={(e) => {
              setTitle(e.target.value);
              setTyped(true);
              setActive(null);
              if (bound) setRetitled(true);
            }}
            onKeyDown={onTitleKey}
          />
          {bound ? (
            <div className="afd-qa-bound" data-bound={bound.ref}>
              <span className="muted">Runs {bound.kind}</span>{' '}
              <span className="mono">{bound.ref}</span>
              <button
                type="button"
                className="icon"
                aria-label={`Do not bind to ${bound.ref}`}
                title="Add the step without a binding"
                onClick={() => {
                  setBound(null);
                  setRetitled(false);
                  titleRef.current?.focus();
                }}
              >
                <span className="codicon codicon-close" aria-hidden="true" />
              </button>
            </div>
          ) : null}
          {suggestions.length > 0 ? (
            <div className="afd-qa-list" id={listId} role="listbox" aria-label="Matching steps">
              {suggestions.map((s, i) => (
                // biome-ignore lint/a11y/useKeyWithClickEvents lint/a11y/useFocusableInteractive: the combobox owns the keys and the focus (aria-activedescendant)
                <div
                  key={`${s.kind}:${s.kind === 'type' ? s.type : s.ref}`}
                  id={`${listId}-${i}`}
                  role="option"
                  aria-selected={i === at}
                  className={i === at ? 'active' : ''}
                  // The field keeps the focus; the click is the pick.
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => choose(s)}
                >
                  <span className="afd-qa-what mono">{s.label}</span>
                  <span className="afd-qa-why muted" title={s.hint}>
                    {s.hint}
                  </span>
                </div>
              ))}
            </div>
          ) : null}
          {suggestions.length > 0 && typed && title.trim() ? (
            <div className="muted afd-qa-keys" data-qa-keys>
              {at >= 0
                ? 'Enter picks the highlighted row; Up from the first row adds the step as typed.'
                : 'Enter adds the step as typed; Down picks from the list.'}
            </div>
          ) : null}
          <div
            className="muted mono afd-key-preview"
            title="The step's name in the file and in the generated code; its ID is made when you add it"
          >
            Key: {key}
          </div>
        </div>
        {type !== 'start' && type !== 'end' ? (
          <div className="afd-field">
            <label htmlFor="afd-qa-intent">Intent (optional)</label>
            <textarea
              id="afd-qa-intent"
              className="afd-input"
              rows={2}
              value={intent}
              placeholder="One sentence on what the step does: a skeleton run prints it"
              onChange={(e) => setIntent(e.target.value)}
            />
          </div>
        ) : null}
        {suggested.length > 0 ? (
          <fieldset className="afd-fieldset">
            <legend>Inputs from {source?.title}</legend>
            {suggested.map(([name, f]) => (
              <label key={name} className="afd-check">
                <input
                  type="checkbox"
                  aria-label={`Input ${name} from ${source?.title ?? 'the step before'}`}
                  checked={inputs.includes(name)}
                  onChange={(e) =>
                    setInputs((xs) =>
                      e.target.checked ? [...xs, name] : xs.filter((x) => x !== name),
                    )
                  }
                />
                <span className="mono">{name}</span> <span className="muted">{f?.type}</span>
              </label>
            ))}
          </fieldset>
        ) : null}
        {offeredPortNames(type).length > 0 ? (
          // AFD-72: folded; each port says what it is for.
          <Fold
            id="quick-add-ports"
            open={ports.length > 0}
            summary={`Extra ports (optional)${ports.length ? `: ${ports.join(', ')}` : ''}`}
          >
            {offeredPortNames(type).map((p) => (
              <label key={p} className="afd-check">
                <input
                  type="checkbox"
                  aria-label={`Port ${p}`}
                  aria-description={portHint(p, type)}
                  checked={ports.includes(p)}
                  onChange={(e) =>
                    setPorts((xs) => (e.target.checked ? [...xs, p] : xs.filter((x) => x !== p)))
                  }
                />
                <span className="mono">{p}</span> <span className="muted">{portHint(p, type)}</span>
              </label>
            ))}
          </Fold>
        ) : null}
        {canFail && rollback ? (
          <label className="afd-check">
            <input
              type="checkbox"
              aria-label={`Wire failed_hosts of the new step to ${rollback.title}`}
              checked={wireRollback}
              onChange={(e) => setWireRollback(e.target.checked)}
            />
            Wire the new step's <span className="mono">failed_hosts</span> to{' '}
            <strong>{rollback.title}</strong>
          </label>
        ) : null}
        <div className="afd-modal-actions">
          <button type="button" className="secondary" onClick={() => close(null)}>
            Cancel
          </button>
          <button type="submit" disabled={!title.trim() || adding} aria-busy={adding}>
            {adding ? 'Adding…' : `Add ${TYPE_LABEL[type]}`}
          </button>
        </div>
      </form>
    </div>
  );
}

// Quick add (04 §4, mockup 02): context, type, title (→ key), intent, inputs suggested from the
// upstream node's outputs, preset optional ports, and "wire failed_hosts to the existing Rollback".
import { type FormEvent, useEffect, useMemo, useRef, useState } from 'react';
import { slugify, uniqueKey } from '../../core/flow/ids';
import { buildModel, ROOT } from '../../core/flow/model';
import { findRollback } from '../../core/flow/patterns';
import { optionalPortNames, portsFor } from '../../core/flow/ports';
import { type ContractField, NODE_TYPES, type NodeType } from '../../core/flow/types';
import { run } from '../actions';
import { TYPE_LABEL } from '../canvas/FlowNodeView';
import { useUi } from '../store';
import { levelView, unplacedPositions } from '../viewModel';

/** Types that can sit on a wire: they have an input and continue on an output. */
const INSERTABLE: readonly NodeType[] = [
  'task',
  'subflow',
  'decision',
  'approval',
  'parallel',
  'join',
];

export function QuickAdd() {
  const quick = useUi((s) => s.quickAdd);
  const snapshot = useUi((s) => s.snapshot);
  const close = useUi((s) => s.openQuickAdd);
  const select = useUi((s) => s.select);
  const [type, setType] = useState<NodeType>('task');
  const [title, setTitle] = useState('');
  const [intent, setIntent] = useState('');
  const [ports, setPorts] = useState<string[]>([]);
  const [inputs, setInputs] = useState<string[]>([]);
  const [wireRollback, setWireRollback] = useState(true);
  const titleRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!quick) return;
    setType(quick.type);
    setTitle(quick.title ?? '');
    setIntent('');
    setPorts([]);
    setInputs([]);
    setWireRollback(true);
    setTimeout(() => titleRef.current?.focus(), 0);
  }, [quick]);

  const model = useMemo(() => (snapshot?.doc ? buildModel(snapshot.doc) : undefined), [snapshot]);
  const levelId = useUi((s) => s.level);
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

  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    if (!title.trim()) return;
    const chosen: Record<string, ContractField> = {};
    for (const name of inputs) {
      const out = source?.outputs?.[name];
      chosen[name] = { type: out?.type ?? 'any', from: `${source?.key}.${name}` };
    }
    const snap = useUi.getState().snapshot;
    // Nodes still at auto-layout positions are written too, so the new node does not move them.
    const freeze =
      snap?.doc && quick.position
        ? unplacedPositions(levelView(snap, useUi.getState().optimistic, levelId), snap.doc.layout)
        : undefined;
    const ack = await run({
      kind: 'addNode',
      parent: levelId === ROOT ? undefined : levelId,
      type,
      title: title.trim(),
      intent: intent.trim() || undefined,
      ports,
      inputs: chosen,
      position: quick.position,
      connectFrom: quick.connectFrom,
      insertOn: quick.insertOn,
      freeze,
      wireFailedTo: canFail && wireRollback && rollback ? rollback.id : undefined,
    });
    if (ack.ok) {
      close(null);
      if (ack.created) select({ node: ack.created });
    }
  };

  return (
    <div className="afd-modal-backdrop">
      <form
        className="afd-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="afd-qa-title"
        onSubmit={submit}
        onKeyDown={(e) => {
          // Only this dialog closes: the page behind it (Properties) stays open.
          if (e.key !== 'Escape') return;
          e.stopPropagation();
          close(null);
        }}
      >
        <h2 id="afd-qa-title">Add node</h2>
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
            placeholder="e.g. Backup config"
            onChange={(e) => setTitle(e.target.value)}
          />
          <div className="muted mono afd-key-preview">key: {key} · ID generated on create</div>
        </div>
        {type !== 'start' && type !== 'end' ? (
          <div className="afd-field">
            <label htmlFor="afd-qa-intent">Intent</label>
            <textarea
              id="afd-qa-intent"
              className="afd-input"
              rows={2}
              value={intent}
              placeholder="One or two sentences: what this step achieves"
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
        {optionalPortNames(type).length > 0 ? (
          <fieldset className="afd-fieldset">
            <legend>Extra ports</legend>
            {optionalPortNames(type).map((p) => (
              <label key={p} className="afd-check">
                <input
                  type="checkbox"
                  checked={ports.includes(p)}
                  onChange={(e) =>
                    setPorts((xs) => (e.target.checked ? [...xs, p] : xs.filter((x) => x !== p)))
                  }
                />
                <span className="mono">{p}</span>
              </label>
            ))}
          </fieldset>
        ) : null}
        {canFail && rollback ? (
          <label className="afd-check">
            <input
              type="checkbox"
              checked={wireRollback}
              onChange={(e) => setWireRollback(e.target.checked)}
            />
            Wire <span className="mono">failed_hosts</span> to <strong>{rollback.title}</strong>
          </label>
        ) : null}
        <div className="afd-modal-actions">
          <button type="button" className="secondary" onClick={() => close(null)}>
            Cancel
          </button>
          <button type="submit" disabled={!title.trim()}>
            Create draft node
          </button>
        </div>
      </form>
    </div>
  );
}

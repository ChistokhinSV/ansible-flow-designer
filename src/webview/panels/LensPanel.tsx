// Lens side panels (04 §1, §7, mockup 09). Left: the lens browser (groups, variables,
// collections…); hovering a row highlights its nodes and dims the rest. Right, with nothing
// selected: the summary, findings with their one-edit fixes, and "Mark expected" (a
// finding_accepted decision with a reason, M8-4).
import { type FormEvent, useEffect, useRef, useState } from 'react';
import { LENSES, type LensFinding, type LensItem } from '../../core/lens/types';
import { run } from '../actions';
import { send } from '../bus';
import { useUi } from '../store';

const labelOf = (id: string) => LENSES.find((l) => l.id === id)?.label ?? id;

function hoverProps(nodes: string[]) {
  const setHighlight = useUi.getState().setHighlight;
  return {
    onMouseEnter: () => setHighlight(nodes.length ? nodes : null),
    onMouseLeave: () => setHighlight(null),
    onFocus: () => setHighlight(nodes.length ? nodes : null),
    onBlur: () => setHighlight(null),
  };
}

function Item({ item }: { item: LensItem }) {
  const reveal = useUi((s) => s.reveal);
  const one = item.nodes.length === 1 ? item.nodes[0] : undefined;
  return (
    <li
      className={`afd-lens-item${item.tone ? ` tone-${item.tone}` : ''}`}
      data-lens-item={item.key}
      {...hoverProps(item.nodes)}
    >
      <button
        type="button"
        className="afd-lens-item-button"
        disabled={!one}
        onClick={() => one && reveal(one)}
        title={one ? 'Show the node' : `${item.nodes.length} nodes`}
      >
        <span className="afd-lens-item-label mono">{item.label}</span>
        {item.value !== undefined ? (
          <span className="afd-lens-item-value">{item.value}</span>
        ) : null}
        {item.detail ? <span className="afd-lens-item-detail muted">{item.detail}</span> : null}
      </button>
    </li>
  );
}

/** Left panel while a lens is on: what the lens counts, row by row. */
export function LensBrowser() {
  const view = useUi((s) => s.lensView);
  const lens = useUi((s) => s.lens);
  const inv = useUi((s) => s.lensFacts.inventory);
  if (!view || !lens) return null;
  const inventory = lens === 'inventory' || lens === 'access';
  return (
    <aside className="afd-left afd-lens-browser" aria-label={`${labelOf(lens)} lens`}>
      <h2 className="afd-panel-title">{labelOf(lens)}</h2>
      {inventory ? (
        <div className="afd-lens-source">
          <p className="muted">
            {inv?.facts
              ? `${inv.facts.sources.join(', ')} · ${inv.facts.total} hosts`
              : inv?.state === 'loading'
                ? 'Reading the inventory…'
                : 'Inventory not read'}
          </p>
          <p>
            Targets: <span className="mono">{inv?.targets || 'not set'}</span>{' '}
            <button type="button" className="link" onClick={() => send({ type: 'setTargets' })}>
              Set targets…
            </button>
          </p>
        </div>
      ) : null}
      {view.sections.map((s) => (
        <section key={s.title} className="afd-section">
          <h3>{s.title}</h3>
          {s.items.length === 0 ? (
            <p className="muted">{s.empty}</p>
          ) : (
            <ul className="afd-lens-items">
              {s.items.map((i) => (
                <Item key={i.key} item={i} />
              ))}
            </ul>
          )}
        </section>
      ))}
    </aside>
  );
}

function Finding({ f }: { f: LensFinding }) {
  const setAccept = useUi((s) => s.setAccept);
  const reveal = useUi((s) => s.reveal);
  const openProperties = useUi((s) => s.openProperties);
  const setError = useUi((s) => s.setError);
  return (
    <li
      className={`afd-finding severity-${f.severity}${f.accepted ? ' accepted' : ''}`}
      data-finding={f.id}
      data-accepted={f.accepted ? 'true' : undefined}
      {...hoverProps(f.nodes)}
    >
      <div className="afd-finding-title">
        <span
          className={`codicon ${f.accepted ? 'codicon-pass' : f.severity === 'warning' ? 'codicon-warning' : 'codicon-info'}`}
          aria-hidden="true"
        />{' '}
        {f.title}
      </div>
      <p className="afd-finding-detail">{f.detail}</p>
      {f.accepted ? (
        <p className="afd-finding-accepted muted">
          Expected: {f.accepted.reason}
          {f.accepted.by ? ` (${f.accepted.by})` : ''}{' '}
          <button
            type="button"
            className="link"
            onClick={() => void run({ kind: 'clearFindingAccept', finding: f.id })}
          >
            Reopen
          </button>
        </p>
      ) : (
        <div className="afd-finding-actions">
          {f.fixes.map((fix) =>
            'command' in fix ? (
              <button
                key={fix.label}
                type="button"
                onClick={() =>
                  void run(fix.command).then((ack) => {
                    if (!ack.ok) setError(ack.error ?? 'The fix failed');
                  })
                }
              >
                {fix.label}
              </button>
            ) : (
              <button
                key={fix.label}
                type="button"
                className="secondary"
                onClick={() => {
                  reveal(fix.properties);
                  openProperties(fix.properties);
                }}
              >
                {fix.label}
              </button>
            ),
          )}
          <button
            type="button"
            className="secondary"
            onClick={() => setAccept({ id: f.id, node: f.node, title: f.title })}
          >
            Mark expected
          </button>
        </div>
      )}
    </li>
  );
}

/** Right panel with nothing selected while a lens is on: summary and findings. */
export function LensPanel() {
  const view = useUi((s) => s.lensView);
  const lens = useUi((s) => s.lens);
  if (!view || !lens) return null;
  const open = view.findings.filter((f) => !f.accepted).length;
  return (
    <div className="afd-panel-body" data-lens-panel={lens}>
      <h2 className="afd-panel-title">
        {labelOf(lens)} lens
        <button
          type="button"
          className="secondary afd-lens-refresh"
          title="Read the facts again"
          onClick={() => send({ type: 'lens', lens, refresh: true })}
        >
          <span className="codicon codicon-refresh" aria-hidden="true" />
        </button>
      </h2>
      {view.stats.length > 0 ? (
        <dl className="afd-lens-stats">
          {view.stats.map((s) => (
            <div key={s.label}>
              <dd>{s.value}</dd>
              <dt>{s.label}</dt>
            </div>
          ))}
        </dl>
      ) : null}
      {view.notes.map((n) => (
        <p key={n} className="muted afd-lens-note">
          {n}
        </p>
      ))}
      <section className="afd-section">
        <h3>Findings {open > 0 ? `(${open})` : ''}</h3>
        {view.findings.length === 0 ? (
          <p className="muted">Nothing to report for this lens.</p>
        ) : (
          <ul className="afd-findings">
            {view.findings.map((f) => (
              <Finding key={f.id} f={f} />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

/** "Mark expected": the reason is required and stored with the Git author (M8-4). */
export function AcceptDialog() {
  const target = useUi((s) => s.accept);
  const close = useUi((s) => s.setAccept);
  const [reason, setReason] = useState('');
  const field = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (!target) return;
    setReason('');
    setTimeout(() => field.current?.focus(), 0);
  }, [target]);
  if (!target) return null;
  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    if (!reason.trim()) return;
    const ack = await run({ kind: 'acceptFinding', finding: target.id, node: target.node, reason });
    if (ack.ok) close(null);
  };
  return (
    <div className="afd-modal-backdrop">
      <form
        className="afd-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="afd-accept-title"
        onSubmit={submit}
        onKeyDown={(e) => {
          // Only this dialog closes: the page behind it (Properties) stays open.
          if (e.key !== 'Escape') return;
          e.stopPropagation();
          close(null);
        }}
      >
        <h2 id="afd-accept-title">Mark as expected</h2>
        <p className="muted">
          <strong>{target.title}</strong>. The finding stays visible as expected; the decision is
          recorded in the flow with your Git user name.
        </p>
        <div className="afd-field">
          <label htmlFor="afd-accept-reason">Reason (required)</label>
          <textarea
            id="afd-accept-reason"
            ref={field}
            className="afd-input"
            rows={3}
            value={reason}
            placeholder="e.g. The spines must drain while the edge switch reboots"
            onChange={(e) => setReason(e.target.value)}
          />
        </div>
        <div className="afd-modal-actions">
          <button type="button" className="secondary" onClick={() => close(null)}>
            Cancel
          </button>
          <button type="submit" disabled={!reason.trim()}>
            Mark expected
          </button>
        </div>
      </form>
    </div>
  );
}

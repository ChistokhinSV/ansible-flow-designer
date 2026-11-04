// One lens finding (M8; AFD-87, wave 8 group F): what it says, where its step is when that is not
// the level on screen, its fixes and Accept with Reason…. The lens tab lists every finding; a
// step's Details list the ones on that step. Round 1: a finding did not say which subflow its step
// is in, and after a fix the canvas kept the fixed step lit (P19); checking a step in Details showed
// no finding (W14).
import { useState } from 'react';
import { modelOf } from '../../core/flow/model';
import { LENSES, type LensFinding } from '../../core/lens/types';
import { placeOf } from '../../core/view/find';
import { run } from '../actions';
import { useUi } from '../store';
import { Fold } from './Fold';

/** Hovering or focusing a row lights its nodes on the canvas and dims the rest (04 §7). */
export function hoverProps(nodes: string[]) {
  const setHighlight = useUi.getState().setHighlight;
  return {
    onMouseEnter: () => setHighlight(nodes.length ? nodes : null),
    onMouseLeave: () => setHighlight(null),
    onFocus: () => setHighlight(nodes.length ? nodes : null),
    onBlur: () => setHighlight(null),
  };
}

/** "in Drain the switch" when the row's step is not on the level on screen. */
export function usePlace(nodes: readonly string[]): string | undefined {
  const doc = useUi((s) => s.snapshot?.doc);
  const level = useUi((s) => s.level);
  const node = nodes.length === 1 ? nodes[0] : undefined;
  return doc && node ? placeOf(modelOf(doc), node, level) : undefined;
}

export function LensFindingRow({
  f,
  onStep,
  onFixed,
}: {
  f: LensFinding;
  /** In a step's Details: its own hook, so the lens tab's findings are not counted twice. */
  onStep?: boolean;
  /** A fix went through: the caller moves on to the next finding. */
  onFixed?: (f: LensFinding) => void;
}) {
  const setAccept = useUi((s) => s.setAccept);
  const reveal = useUi((s) => s.reveal);
  const openDetails = useUi((s) => s.openDetails);
  const setError = useUi((s) => s.setError);
  const place = usePlace(f.node ? [f.node] : f.nodes);
  const hook = onStep ? { 'data-node-finding': f.id } : { 'data-finding': f.id };
  return (
    <li
      className={`afd-finding severity-${f.severity}${f.accepted ? ' accepted' : ''}`}
      {...hook}
      data-accepted={f.accepted ? 'true' : undefined}
      {...hoverProps(f.nodes)}
    >
      <div className="afd-finding-title">
        <span
          className={`codicon ${f.accepted ? 'codicon-pass' : f.severity === 'warning' ? 'codicon-warning' : 'codicon-info'}`}
          aria-hidden="true"
        />{' '}
        {f.title}
        {place ? (
          <span className="afd-finding-place muted" data-finding-place>
            {' '}
            · {place}
          </span>
        ) : null}
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
                    if (!ack.ok) return setError(ack.error ?? 'The fix failed');
                    // The row goes away with the fix and fires no blur: drop its highlight here.
                    useUi.getState().setHighlight(null);
                    onFixed?.(f);
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
                  openDetails(fix.properties);
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
            Accept with Reason…
          </button>
        </div>
      )}
    </li>
  );
}

/** The first open finding after `after` (or from the top), skipping the ones in `skip`. */
export function nextOpen(
  findings: readonly LensFinding[],
  after: string | undefined,
  skip: (f: LensFinding) => boolean = () => false,
): LensFinding | undefined {
  const from = after ? findings.findIndex((f) => f.id === after) + 1 : 0;
  const ordered = [...findings.slice(from), ...findings.slice(0, from)];
  return ordered.find((f) => !f.accepted && f.id !== after && !skip(f));
}

/**
 * A step's lens findings in its Details (W14): a fold under the step's name, open while one is not
 * accepted. After a fix leaves the step with none, Next Finding shows the step of the next open one.
 */
export function StepFindings({ id }: { id: string }) {
  const lens = useUi((s) => s.lens);
  const view = useUi((s) => s.lensView);
  const [fixed, setFixed] = useState<string | null>(null);
  if (!lens || !view) return null;
  const onStep = (f: LensFinding) => f.node === id || f.nodes.includes(id);
  const mine = view.findings.filter(onStep);
  const label = LENSES.find((l) => l.id === lens)?.label ?? lens;
  const next = fixed ? nextOpen(view.findings, fixed, onStep) : undefined;
  if (mine.length === 0 && !fixed) return null;
  return (
    <div className="afd-step-findings" data-step-findings={id}>
      {mine.length > 0 ? (
        <Fold
          id={`lens-${lens}`}
          summary={`Lens: ${label} · ${mine.length} on this step`}
          open={mine.some((f) => !f.accepted)}
        >
          <ul className="afd-findings">
            {mine.map((f) => (
              <LensFindingRow key={f.id} f={f} onStep onFixed={(done) => setFixed(done.id)} />
            ))}
          </ul>
        </Fold>
      ) : (
        <p className="muted" role="status">
          No {label} findings left on this step.
        </p>
      )}
      {next && !mine.some((f) => !f.accepted) ? (
        <button
          type="button"
          className="link"
          data-next-finding={next.id}
          onClick={() => {
            const to = next.node ?? next.nodes[0];
            if (to) useUi.getState().reveal(to);
          }}
        >
          Next Finding: {next.title}
        </button>
      ) : null}
    </div>
  );
}

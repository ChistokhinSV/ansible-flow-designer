// AFD-283: a merge git left to the designer. Each conflict is a place both sides changed: mine or
// theirs is chosen here, and the file follows at once (ours until chosen). Finish takes the file as
// merged (git add). A step with a conflict is shown on the canvas from its line.
import type { MergeSide } from '../../core/flow/merge';
import type { MergeView } from '../../core/protocol';
import { send } from '../bus';
import { useUi } from '../store';

/** A value as a line can show it: words as they are, anything else as short JSON. */
function shown(v: unknown): string {
  if (v === undefined) return '(none)';
  if (typeof v === 'string') return v.length > 80 ? `${v.slice(0, 77)}…` : v;
  const text = JSON.stringify(v);
  return text.length > 80 ? `${text.slice(0, 77)}…` : text;
}

function Choice({
  id,
  side,
  chosen,
  value,
}: {
  id: string;
  side: MergeSide;
  chosen: MergeSide;
  value: unknown;
}) {
  const label = side === 'ours' ? 'Mine' : 'Theirs';
  return (
    <button
      type="button"
      className={chosen === side ? 'afd-merge-pick chosen' : 'afd-merge-pick'}
      aria-pressed={chosen === side}
      title={`${label}: ${shown(value)}`}
      onClick={() => send({ type: 'mergeChoose', id, side })}
    >
      {label}: <span className="afd-merge-value">{shown(value)}</span>
    </button>
  );
}

export function MergeNote() {
  const merge = useUi((s) => s.merge) as MergeView | null;
  if (!merge) return null;
  const n = merge.conflicts.length;
  return (
    <section className="afd-merge-note" aria-label="Merge" data-merge-conflicts={n}>
      <strong>Merge:</strong>{' '}
      {n
        ? `${n} place${n === 1 ? '' : 's'} both sides changed. Choose for each; the flow shows the choice at once.`
        : 'Nothing to choose.'}{' '}
      <button
        type="button"
        className="link"
        onClick={() => send({ type: 'mergeFinish' })}
        title="Take the file as merged (git add)"
      >
        Finish merge
      </button>
      {merge.broken.length ? (
        <p className="afd-merge-broken">
          The merged flow breaks a rule neither side broke: {merge.broken.join('; ')}
        </p>
      ) : null}
      <ul className="afd-merge-list">
        {merge.conflicts.map((c) => (
          <li key={c.id} data-merge-conflict={c.id}>
            {c.node ? (
              <button
                type="button"
                className="link"
                onClick={() => {
                  const ui = useUi.getState();
                  if (c.node) {
                    ui.reveal(c.node);
                    ui.setHighlight([c.node]);
                  }
                }}
              >
                {c.label}
              </button>
            ) : (
              c.label
            )}{' '}
            <Choice id={c.id} side="ours" chosen={c.chosen} value={c.ours} />{' '}
            <Choice id={c.id} side="theirs" chosen={c.chosen} value={c.theirs} />
          </li>
        ))}
      </ul>
    </section>
  );
}

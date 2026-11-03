// A level with nothing but Start and End (AFD-48): a card under them says how to begin, the first
// step after Start (on the Start to End wire of a new flow), or a flow made from playbooks, an AWX
// workflow or a sample. Inside a subflow, only the first step. Design mode only, while the flow
// can be edited.
import { ROOT } from '../../core/flow/model';
import { EMPTY_CARD } from '../../core/view/fit';
import { send } from '../bus';
import { canEdit } from '../editActions';
import { useLevelView } from '../hooks';
import { addNode } from '../portActions';
import { useUi } from '../store';

/** The level has no step, only Start and End (or nothing yet). */
export function onlyEnds(nodes: readonly { node: { type: string } }[]): boolean {
  return nodes.every((n) => n.node.type === 'start' || n.node.type === 'end');
}

/** Whether the card shows: Design mode, an editable flow, a level without steps. */
export function useEmptyLevel(): boolean {
  const view = useLevelView();
  const design = useUi((s) => s.mode === 'design');
  const editable = useUi(() => canEdit());
  return design && editable && onlyEnds(view.nodes);
}

/** Drawn in the canvas's own coordinates (a viewport portal), at `at`, under the nodes. */
export function EmptyLevel({ at }: { at: { x: number; y: number } }) {
  const view = useLevelView();
  const level = useUi((s) => s.level);
  const shown = useEmptyLevel();
  if (!shown) return null;
  const start = view.nodes.find((n) => n.node.type === 'start')?.node.id;
  // A new flow wires Start to End: the first step goes on that wire, between them.
  const addStep = () => addNode(start);
  const top = level === ROOT;
  return (
    <section
      className="afd-empty-level nodrag nopan"
      aria-label="Start this level"
      data-empty-level
      style={{ transform: `translate(${at.x}px, ${at.y}px)`, width: EMPTY_CARD.width }}
    >
      <h2>{top ? 'Start with a Step' : 'This subflow has no steps yet'}</h2>
      <p className="muted">
        {top
          ? 'Add the first step after Start, then wire what happens when it fails. Or begin from what you already have.'
          : 'Add the first step; the wires into and out of the frame lead to it.'}
      </p>
      <div className="afd-empty-actions">
        <button type="button" onClick={addStep}>
          <span className="codicon codicon-add" aria-hidden="true" /> Add a Step{' '}
          <kbd className="afd-menu-key">N</kbd>
        </button>
        {top ? (
          <>
            <button
              type="button"
              className="secondary"
              onClick={() => send({ type: 'startFrom', what: 'playbooks' })}
            >
              Import Ansible Playbooks…
            </button>
            <button
              type="button"
              className="secondary"
              onClick={() => send({ type: 'startFrom', what: 'awx' })}
            >
              Import AWX Workflow or Job Template…
            </button>
            <button
              type="button"
              className="secondary"
              onClick={() => send({ type: 'startFrom', what: 'sample' })}
            >
              Open Sample Flow…
            </button>
          </>
        ) : null}
      </div>
      {top ? (
        <p className="muted">
          New here?{' '}
          <button
            type="button"
            className="link"
            onClick={() => send({ type: 'startFrom', what: 'tour' })}
          >
            Get Started
          </button>{' '}
          walks you through a first flow.
        </p>
      ) : null}
    </section>
  );
}

// The first-flow checklist (AFD-73, ADR-0030): four things that make a first flow, over the canvas's
// bottom left, on a top level with one to five steps, until all are done or the user hides it (for
// good; "…" shows it again). Each item has Show Me: it does the step, or opens where it is done.
import { ROOT } from '../../core/flow/model';
import { type FirstFlowId, firstFlowItems, isFirstFlowSize } from '../../core/view/firstFlow';
import { send } from '../bus';
import { canEdit } from '../editActions';
import { addNode, openPortMenuSoon } from '../portActions';
import { startRun } from '../runActions';
import { useUi } from '../store';

/** Whether the checklist is on the canvas (the minimap keeps out of its corner). */
export function useFirstFlowShown(): boolean {
  return useUi(
    (s) =>
      !!s.snapshot?.doc &&
      !!s.firstFlow &&
      !s.firstFlow.hidden &&
      s.mode === 'design' &&
      s.level === ROOT &&
      canEdit() &&
      isFirstFlowSize(s.snapshot.doc),
  );
}

export function FirstFlow() {
  const snapshot = useUi((s) => s.snapshot);
  const state = useUi((s) => s.firstFlow);
  const shown = useFirstFlowShown();
  const doc = snapshot?.doc;
  if (!doc || !state || !shown) return null;
  const items = firstFlowItems(doc, snapshot.openPorts.length, state.done);
  const done = items.filter((i) => i.done).length;
  const hide = () => send({ type: 'firstFlow', hidden: true });
  const firstStep = (doc.nodes ?? []).find((n) => n && n.type !== 'start' && n.type !== 'end');
  const showMe = (id: FirstFlowId) => {
    const ui = useUi.getState();
    if (id === 'step') addNode((doc.nodes ?? []).find((n) => n?.type === 'start')?.id);
    else if (id === 'code' && firstStep) {
      ui.select({ node: firstStep.id });
      send({ type: 'peekCode', node: firstStep.id });
    } else if (id === 'failure' && snapshot.openPorts[0]) openPortMenuSoon(snapshot.openPorts[0]);
    else if (id === 'run') startRun('check');
  };
  return (
    <details className="afd-first-flow nodrag nopan" open data-first-flow={done}>
      <summary>
        Your first flow · {done} of {items.length}
      </summary>
      {done === items.length ? (
        <p>
          Your first flow is done. Next:{' '}
          <button
            type="button"
            className="link"
            onClick={() =>
              send({ type: 'openGuide', page: 'tutorials/02-design-to-production.md' })
            }
          >
            Tutorial 2
          </button>
          .
        </p>
      ) : (
        <ol>
          {items.map((item) => (
            <li key={item.id} className={item.done ? 'done' : ''}>
              <span
                className={`codicon codicon-${item.done ? 'pass-filled' : 'circle-large-outline'}`}
                aria-hidden="true"
              />
              <span>
                <strong>{item.label}</strong>
                {item.done ? null : <span className="muted"> {item.detail}</span>}{' '}
                {item.done || (item.id !== 'step' && !firstStep) ? null : (
                  <button
                    type="button"
                    className="link"
                    aria-label={`Show me: ${item.label}`}
                    onClick={() => showMe(item.id)}
                  >
                    Show Me
                  </button>
                )}
              </span>
            </li>
          ))}
        </ol>
      )}
      <button type="button" className="link" onClick={hide}>
        Hide Checklist
      </button>
    </details>
  );
}

// What changed outside the designer since it opened (AFD-85, wave 8 group H): an agent, a command
// line or another extension rewrote the flow, and the canvas rebuilt with no trace of it (round 1:
// P21). Show lights the marked steps and opens the first; Clear drops the marks. Kept apart from
// the Changes lens, which compares with Git and so mixes in the person's own edits.
import { marksText } from '../../core/view/outsideChanges';
import { send } from '../bus';
import { useUi } from '../store';

export function OutsideNote() {
  const marks = useUi((s) => s.outside);
  if (!marks) return null;
  const at = new Date(marks.since).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return (
    <div className="afd-outside-note" role="status" data-outside-note={marks.nodes.length}>
      <span className="afd-swatch outside" aria-hidden="true" />{' '}
      <span>
        {marksText(marks)} since you opened it (first at {at}).
      </span>{' '}
      {marks.nodes.length ? (
        <button
          type="button"
          className="link"
          onClick={() => {
            const ui = useUi.getState();
            const first = marks.nodes[0];
            if (first) ui.reveal(first);
            ui.setHighlight(marks.nodes);
          }}
        >
          Show
        </button>
      ) : null}{' '}
      <button
        type="button"
        className="link"
        onClick={() => {
          useUi.getState().setHighlight(null);
          send({ type: 'clearOutside' });
        }}
      >
        Clear
      </button>
    </div>
  );
}

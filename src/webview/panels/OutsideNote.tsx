// What changed outside the designer since it opened (AFD-85, wave 8 group H): an agent, a command
// line or another extension rewrote the flow, and the canvas rebuilt with no trace of it (round 1:
// P21). Show lights the marked steps and opens the first; Clear drops the marks. Kept apart from
// the Changes lens, which compares with Git and so mixes in the person's own edits. AFD-92: also
// what changed while the flow was closed, "since you last had this flow open" (round 2: S12).
import { marksText } from '../../core/view/outsideChanges';
import { send } from '../bus';
import { useUi } from '../store';

/** "14:02" today, "4 Nov, 20:49" before: marks can be days old since AFD-92. */
export function whenText(iso: string, now = new Date()): string {
  const at = new Date(iso);
  const time = at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (at.toDateString() === now.toDateString()) return time;
  return `${at.toLocaleDateString([], { day: 'numeric', month: 'short' })}, ${time}`;
}

export function OutsideNote() {
  const marks = useUi((s) => s.outside);
  if (!marks) return null;
  const at = whenText(marks.since);
  return (
    <div
      className="afd-outside-note"
      role="status"
      data-outside-note={marks.nodes.length}
      data-outside-closed={marks.closed ? 'true' : undefined}
    >
      <span className="afd-swatch outside" aria-hidden="true" />{' '}
      <span>
        {marksText(marks)}{' '}
        {marks.closed
          ? `since you last had this flow open (${at}).`
          : `since you opened it (first at ${at}).`}
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

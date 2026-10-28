// Left panel in Design mode (04 §1): node palette and legend. Click adds a node near the middle of
// the view; dragging onto the canvas adds it where it is dropped. Failure patterns arrive in M2.
import { useReactFlow } from '@xyflow/react';
import type { NodeType } from '../../core/flow/types';
import { DRAG_MIME } from '../canvas/FlowCanvas';
import { TYPE_LABEL } from '../canvas/FlowNodeView';
import { useUi } from '../store';

const ITEMS: { type: NodeType; icon: string; hint: string }[] = [
  { type: 'task', icon: 'symbol-event', hint: 'One step: a module, role or playbook' },
  { type: 'subflow', icon: 'type-hierarchy-sub', hint: 'A step with its own inner graph' },
  { type: 'decision', icon: 'git-compare', hint: 'Route each host on a condition' },
  { type: 'approval', icon: 'pass', hint: 'Wait for an approval' },
  { type: 'parallel', icon: 'split-horizontal', hint: 'Send the hosts down several branches' },
  { type: 'join', icon: 'merge', hint: 'Bring branches back together' },
  { type: 'start', icon: 'debug-start', hint: 'Entry point of the flow' },
  { type: 'end', icon: 'debug-stop', hint: 'Exit of the flow' },
];

export function Palette() {
  const openQuickAdd = useUi((s) => s.openQuickAdd);
  const { screenToFlowPosition } = useReactFlow();
  const addCentered = (type: NodeType) => {
    const canvas = document.querySelector('.react-flow')?.getBoundingClientRect();
    const position = canvas
      ? screenToFlowPosition({
          x: canvas.left + canvas.width / 2,
          y: canvas.top + canvas.height / 3,
        })
      : undefined;
    openQuickAdd({ type, position });
  };
  return (
    <aside className="afd-left" aria-label="Palette">
      <h2>Nodes</h2>
      <ul className="afd-palette">
        {ITEMS.map((item) => (
          <li key={item.type}>
            <button
              type="button"
              draggable
              onDragStart={(e) => {
                e.dataTransfer.setData(DRAG_MIME, item.type);
                e.dataTransfer.effectAllowed = 'copy';
              }}
              onClick={() => addCentered(item.type)}
              title={item.hint}
            >
              <span className={`codicon codicon-${item.icon}`} aria-hidden="true" />
              {TYPE_LABEL[item.type]}
            </button>
          </li>
        ))}
      </ul>
      <h2>Legend</h2>
      <ul className="afd-legend">
        <li>
          <span className="afd-swatch port state-connected tone-ok" /> Connected port
        </li>
        <li>
          <span className="afd-swatch port state-open-fail tone-failed" /> Open fail port (needs a
          decision)
        </li>
        <li>
          <span className="afd-swatch port state-open-purpose tone-failed" /> Open on purpose
        </li>
        <li>
          <span className="afd-swatch port state-open tone-ok optional" /> Optional port, enabled
        </li>
        <li>
          <span className="afd-swatch wire" /> Normal outcome
        </li>
        <li>
          <span className="afd-swatch wire problem" /> Problem path
        </li>
      </ul>
    </aside>
  );
}

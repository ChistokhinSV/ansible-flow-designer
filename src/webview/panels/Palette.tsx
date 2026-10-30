// Left panel in Design mode (04 §1): node palette, failure patterns (D-16) and legend. A node type
// click adds a node near the middle of the view; dragging adds it where it is dropped. A pattern
// is dragged onto an open fail port (or a node), or clicked to resolve the selected node.
import { useReactFlow } from '@xyflow/react';
import { PATTERNS, type PatternId } from '../../core/flow/patterns';
import type { NodeType } from '../../core/flow/types';
import { DRAG_MIME, PATTERN_MIME } from '../canvas/FlowCanvas';
import { TYPE_LABEL } from '../canvas/FlowNodeView';
import { dropPattern } from '../portActions';
import { useUi } from '../store';

const PATTERN_ICON: Partial<Record<PatternId, string>> = {
  rollback: 'discard',
  'notify-stop': 'bell',
  retry: 'refresh',
  exclude: 'circle-slash',
};
const PALETTE_PATTERNS = Object.values(PATTERNS).filter((p) => p.palette);

/** Body class while a pattern is dragged: every node shows its problem ports (styles.css). */
const DRAGGING = 'afd-dragging-pattern';

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
  // Run mode is read-only (AFD-18): the palette shows what exists but adds nothing.
  const locked = useUi((s) => s.mode === 'run');
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
      {locked ? <p className="afd-palette-hint muted">Run mode is read-only</p> : null}
      <ul className="afd-palette">
        {ITEMS.map((item) => (
          <li key={item.type}>
            <button
              type="button"
              draggable={!locked}
              disabled={locked}
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
      <h2>Failure patterns</h2>
      <p className="afd-palette-hint muted">Drop onto an open fail port</p>
      <ul className="afd-palette">
        {PALETTE_PATTERNS.map((p) => (
          <li key={p.id}>
            <button
              type="button"
              draggable={!locked}
              disabled={locked}
              data-pattern={p.id}
              onDragStart={(e) => {
                e.dataTransfer.setData(PATTERN_MIME, p.id);
                e.dataTransfer.effectAllowed = 'copy';
                document.body.classList.add(DRAGGING);
              }}
              onDragEnd={() => document.body.classList.remove(DRAGGING)}
              onClick={() => {
                const node = useUi.getState().selection.node;
                if (node) void dropPattern(p.id, node);
                else
                  useUi.getState().setError('Select a node first, or drag the pattern onto a port');
              }}
              title={`${p.hint}. Accepts: ${p.accepts.join(', ')}`}
            >
              <span
                className={`codicon codicon-${PATTERN_ICON[p.id] ?? 'symbol-event'}`}
                aria-hidden="true"
              />
              {p.label}
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
          <span className="afd-swatch port state-open tone-ok optional" /> Optional port, shown on
          hover
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

// Right panel for a selected boundary wire (D-23): the entry, or an exit with its reason (mockup 10
// "SSH timeout"). Each change is one command; removing goes through the same commands as Delete.
import { buildModel } from '../../core/flow/model';
import { run } from '../actions';
import { useUi } from '../store';
import { boundaryView, levelView } from '../viewModel';
import { CommitField } from './fields';

export function BoundaryPanel({ edge }: { edge: string }) {
  const snapshot = useUi((s) => s.snapshot);
  const level = useUi((s) => s.level);
  const select = useUi((s) => s.select);
  if (!snapshot?.doc) return null;
  const view = levelView(snapshot, {}, level);
  const b = boundaryView(snapshot, view, level);
  const wire = b?.edges.find((e) => e.id === edge);
  if (!b || !wire) return null;
  const model = buildModel(snapshot.doc);
  const title = (id: string) => model.nodes.get(id)?.node.title ?? id;
  const subflow = b.subflow.id;

  if (!wire.exit) {
    return (
      <div className="afd-panel-body" data-boundary-panel="entry">
        <h2 className="afd-panel-title">Entry of {b.subflow.title}</h2>
        <p className="muted">
          Hosts entering <strong>{b.subflow.title}</strong> start at{' '}
          <strong>{title(wire.target)}</strong>. Drag from the frame's{' '}
          <span className="mono">in</span> to another step to move the entry.
        </p>
        <button
          type="button"
          className="secondary"
          onClick={() => {
            select({});
            void run({ kind: 'setBoundaryIn', subflow, node: null });
          }}
        >
          Remove entry
        </button>
      </div>
    );
  }

  const exit = wire.exit;
  return (
    <div className="afd-panel-body" data-boundary-panel="exit">
      <h2 className="afd-panel-title">Exit to {exit.port}</h2>
      <p className="muted">
        Hosts leaving <strong>{title(exit.from.node)}</strong> ·{' '}
        <span className="mono">{exit.from.port}</span> leave <strong>{b.subflow.title}</strong>{' '}
        through <span className="mono">{exit.port}</span>.
      </p>
      <CommitField
        label="Reason (shown on the wire)"
        focusKey="exitReason"
        value={exit.reason ?? ''}
        placeholder="e.g. SSH timeout"
        onCommit={(v) =>
          void run({ kind: 'setExitReason', subflow, from: exit.from, port: exit.port, reason: v })
        }
      />
      <button
        type="button"
        className="secondary"
        onClick={() => {
          select({});
          void run({ kind: 'disconnectBoundary', subflow, from: exit.from, port: exit.port });
        }}
      >
        Remove exit
      </button>
    </div>
  );
}

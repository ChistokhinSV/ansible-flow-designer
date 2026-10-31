// Hint while a port menu action waits for a node click ("Connect to another node…", "Rewire…").
// Escape cancels it (keyboard.ts).
import { buildModel } from '../../core/flow/model';
import { useUi } from '../store';

const VERB = {
  to: 'Click the node to wire',
  rewire: 'Click the new target of',
  from: 'Click the node that feeds',
} as const;

export function PickBar() {
  const pick = useUi((s) => s.pick);
  const snapshot = useUi((s) => s.snapshot);
  const setPick = useUi((s) => s.setPick);

  if (!pick) return null;
  // Any level: the port may belong to a step inside a subflow (AFD-30).
  const doc = snapshot?.doc;
  const title = (doc && buildModel(doc).nodes.get(pick.ref.node)?.node.title) ?? pick.ref.node;
  return (
    <div className="afd-banner info" role="status" data-pick={pick.mode}>
      <span className="codicon codicon-target" aria-hidden="true" />
      <span>
        {VERB[pick.mode]} <strong>{title}</strong> · <span className="mono">{pick.ref.port}</span>
      </span>
      <span className="muted">Esc to cancel</span>
      <button type="button" className="link" onClick={() => setPick(null)}>
        Cancel
      </button>
    </div>
  );
}

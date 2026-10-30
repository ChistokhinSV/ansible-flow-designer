// Hint while a port menu action waits for a node click ("Connect to another node…", "Rewire…").
// Escape cancels it (keyboard.ts).
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
  const title = snapshot?.doc?.nodes.find((n) => n.id === pick.ref.node)?.title ?? pick.ref.node;
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

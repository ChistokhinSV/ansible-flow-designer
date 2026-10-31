// "Leave open on purpose" (D-15, decision 13): anyone may record it, a reason is required, and the
// host fills `by` from the Git user name (or the OS user).
import { modelOf } from '../../core/flow/model';
import { run } from '../actions';
import { useUi } from '../store';
import { ReasonDialog } from './ReasonDialog';

export function DecisionDialog() {
  const target = useUi((s) => s.decide);
  const snapshot = useUi((s) => s.snapshot);
  const close = useUi((s) => s.setDecide);
  if (!target) return null;
  const existing = (snapshot?.doc?.decisions ?? []).find(
    (d) => d?.node === target.node && d.port === target.port,
  );
  const doc = snapshot?.doc;
  const node = doc ? modelOf(doc).nodes.get(target.node)?.node : undefined;
  return (
    <ReasonDialog
      id="afd-decide"
      title="Leave open on purpose"
      placeholder="e.g. Fails before any change; stopping is safe"
      submit={existing ? 'Save reason' : 'Leave open'}
      initial={existing?.reason}
      target={target}
      record={(reason) =>
        run({ kind: 'setDecision', node: target.node, port: target.port, reason })
      }
      close={() => close(null)}
    >
      <strong>{node?.title ?? target.node}</strong> · <span className="mono">{target.port}</span>{' '}
      stays unwired: hosts that take it fail the run visibly and stop there. The warning goes away
      and the decision is recorded in the flow with your Git user name.
    </ReasonDialog>
  );
}

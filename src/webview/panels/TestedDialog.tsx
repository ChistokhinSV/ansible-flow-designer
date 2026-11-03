// `tested` by hand (AFD-44, decision 10): a passing real run marks nodes tested by itself; without
// one, a reason is required and the host records it with the Git user name (markTested).
import { modelOf } from '../../core/flow/model';
import { run } from '../actions';
import { useUi } from '../store';
import { ReasonDialog } from './ReasonDialog';

export function TestedDialog() {
  const target = useUi((s) => s.testedReason);
  const doc = useUi((s) => s.snapshot?.doc);
  const close = useUi((s) => s.setTestedReason);
  if (!target) return null;
  const node = doc ? modelOf(doc).nodes.get(target)?.node : undefined;
  return (
    <ReasonDialog
      id="afd-tested"
      title="Mark Tested"
      placeholder="e.g. Ran by hand on sw-lab-01 with the same parameters"
      submit="Mark Tested"
      target={target}
      record={(reason) => run({ kind: 'markTested', id: target, reason })}
      close={() => close(null)}
    >
      <strong>{node?.title ?? target}</strong> counts as tested without a passing run of this flow.
      A passing real run marks nodes tested by itself (Run mode); here, say why. The reason is
      recorded in the flow with your Git user name, and goes when the node's design changes.
    </ReasonDialog>
  );
}

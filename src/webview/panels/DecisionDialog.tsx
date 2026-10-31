// "Leave open on purpose" (D-15, decision 13): anyone may record it, a reason is required, and the
// host fills `by` from the Git user name (or the OS user).
import { type FormEvent, useEffect, useRef, useState } from 'react';
import { modelOf } from '../../core/flow/model';
import { run } from '../actions';
import { useUi } from '../store';

export function DecisionDialog() {
  const target = useUi((s) => s.decide);
  const snapshot = useUi((s) => s.snapshot);
  const close = useUi((s) => s.setDecide);
  const existing = (snapshot?.doc?.decisions ?? []).find(
    (d) => d?.node === target?.node && d.port === target?.port,
  );
  const [reason, setReason] = useState('');
  const field = useRef<HTMLTextAreaElement>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: runs when the dialog opens for a port; later snapshots must not reset what is being typed
  useEffect(() => {
    if (!target) return;
    setReason(existing?.reason ?? '');
    setTimeout(() => field.current?.focus(), 0);
  }, [target]);

  if (!target) return null;
  const doc = snapshot?.doc;
  const node = doc ? modelOf(doc).nodes.get(target.node)?.node : undefined;

  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    if (!reason.trim()) return;
    const ack = await run({ kind: 'setDecision', node: target.node, port: target.port, reason });
    if (ack.ok) close(null);
  };

  return (
    <div className="afd-modal-backdrop">
      <form
        className="afd-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="afd-decide-title"
        onSubmit={submit}
        onKeyDown={(e) => {
          // Only this dialog closes: the page behind it (Properties) stays open.
          if (e.key !== 'Escape') return;
          e.stopPropagation();
          close(null);
        }}
      >
        <h2 id="afd-decide-title">Leave open on purpose</h2>
        <p className="muted">
          <strong>{node?.title ?? target.node}</strong> ·{' '}
          <span className="mono">{target.port}</span> stays unwired: hosts that take it fail the run
          visibly and stop there. The warning goes away and the decision is recorded in the flow
          with your Git user name.
        </p>
        <div className="afd-field">
          <label htmlFor="afd-decide-reason">Reason (required)</label>
          <textarea
            id="afd-decide-reason"
            ref={field}
            className="afd-input"
            rows={3}
            value={reason}
            placeholder="e.g. Fails before any change; stopping is safe"
            onChange={(e) => setReason(e.target.value)}
          />
        </div>
        <div className="afd-modal-actions">
          <button type="button" className="secondary" onClick={() => close(null)}>
            Cancel
          </button>
          <button type="submit" disabled={!reason.trim()}>
            {existing ? 'Save reason' : 'Leave open'}
          </button>
        </div>
      </form>
    </div>
  );
}

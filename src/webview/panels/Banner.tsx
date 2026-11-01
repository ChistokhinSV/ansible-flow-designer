// Open fail port banner (D-15): count of open fail-type ports not marked open on purpose. "Show"
// selects the affected nodes one by one; dismissing hides it until the count changes. A flow
// written by hand without IDs (AFD-19) shows Complete IDs here first: the canvas edits after it.
import { useReactFlow } from '@xyflow/react';
import { send } from '../bus';
import { useUi } from '../store';
import { bannerCount } from '../viewModel';

/** Module-level so cycling continues across level switches (each level remounts the canvas). */
let cursor = 0;

export function Banner() {
  const snapshot = useUi((s) => s.snapshot);
  const dismissedAt = useUi((s) => s.bannerDismissedAt);
  const dismiss = useUi((s) => s.dismissBanner);
  const select = useUi((s) => s.select);
  const reveal = useUi((s) => s.reveal);
  const level = useUi((s) => s.level);
  const { getNode, setCenter } = useReactFlow();
  if (!snapshot) return null;
  if (snapshot.stale) {
    return (
      <div className="afd-banner error" role="alert">
        <span className="codicon codicon-error" aria-hidden="true" />
        The text has YAML errors: {snapshot.parseError}. Showing the last valid version; editing is
        paused.
      </div>
    );
  }
  if (snapshot.idGaps) {
    const n = snapshot.idGaps;
    return (
      <div className="afd-banner warning" role="status" data-id-gaps={n}>
        <span className="codicon codicon-edit" aria-hidden="true" />
        <strong>Written by hand:</strong>
        <span className="muted">
          {n} {n === 1 ? 'item needs an ID' : 'items need IDs'} before the canvas can edit this
          flow.
        </span>
        <button type="button" onClick={() => send({ type: 'completeIds' })}>
          Complete IDs
        </button>
      </div>
    );
  }
  const count = bannerCount(snapshot.openPorts);
  if (count === 0 || dismissedAt === count) {
    return <span hidden data-banner-count={count} />;
  }
  const show = () => {
    const open = snapshot.openPorts[cursor % snapshot.openPorts.length];
    cursor++;
    if (!open) return;
    if (open.level !== level) {
      reveal(open.node);
      return;
    }
    select({ node: open.node });
    const n = getNode(open.node);
    if (n)
      void setCenter(n.position.x + (n.width ?? 0) / 2, n.position.y + (n.height ?? 0) / 2, {
        duration: 200,
        zoom: 1,
      });
  };
  return (
    <div className="afd-banner warning" role="status" data-banner-count={count}>
      <span className="codicon codicon-warning" aria-hidden="true" />
      <strong>
        {count} open fail port{count === 1 ? '' : 's'}
      </strong>
      <span className="muted">
        Wire them to a handler, or Accept with Reason… on a port you keep open.
      </span>
      <button type="button" className="link" onClick={show}>
        Show
      </button>
      <button type="button" className="icon" aria-label="Dismiss" onClick={() => dismiss(count)}>
        <span className="codicon codicon-close" aria-hidden="true" />
      </button>
    </div>
  );
}

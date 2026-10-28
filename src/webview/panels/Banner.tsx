// Open fail port banner (D-15): count of open fail-type ports not marked open on purpose. "Show"
// selects the affected nodes one by one; dismissing hides it until the count changes.
import { useReactFlow } from '@xyflow/react';
import { useRef } from 'react';
import { useUi } from '../store';
import { bannerCount } from '../viewModel';

export function Banner() {
  const snapshot = useUi((s) => s.snapshot);
  const dismissedAt = useUi((s) => s.bannerDismissedAt);
  const dismiss = useUi((s) => s.dismissBanner);
  const select = useUi((s) => s.select);
  const { getNode, setCenter } = useReactFlow();
  const cursor = useRef(0);
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
  const count = bannerCount(snapshot.openPorts);
  if (count === 0 || dismissedAt === count) {
    return <span hidden data-banner-count={count} />;
  }
  const show = () => {
    const open = snapshot.openPorts[cursor.current % snapshot.openPorts.length];
    cursor.current++;
    if (!open) return;
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
      <span className="muted">Wire them to a handler or mark them open on purpose.</span>
      <button type="button" className="link" onClick={show}>
        Show
      </button>
      <button type="button" className="icon" aria-label="Dismiss" onClick={() => dismiss(count)}>
        <span className="codicon codicon-close" aria-hidden="true" />
      </button>
    </div>
  );
}

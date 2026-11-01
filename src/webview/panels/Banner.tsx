// Open fail port banner (D-15): count of open fail-type ports not marked open on purpose. "Show"
// selects the affected nodes one by one; dismissing hides it until the count changes. A flow
// written by hand without IDs (AFD-19) shows Complete IDs here first: the canvas edits after it.
import { CURRENT_FORMAT, formatOf, upgradeNotes } from '../../core/flow/migrate';
import { run } from '../actions';
import { send } from '../bus';
import { useEditable } from '../editActions';
import { useUi } from '../store';
import { bannerCount } from '../viewModel';

/** Module-level so cycling continues across level switches (each level remounts the canvas). */
let cursor = 0;

export function Banner() {
  const snapshot = useUi((s) => s.snapshot);
  const dismissedAt = useUi((s) => s.bannerDismissedAt);
  const dismiss = useUi((s) => s.dismissBanner);
  const reveal = useUi((s) => s.reveal);
  if (!snapshot) return null;
  if (snapshot.stale) {
    return (
      <div className="afd-banner error" role="alert" data-read-only-banner>
        <span className="codicon codicon-error" aria-hidden="true" />
        <span>
          <strong>Read-only:</strong> the text has YAML errors ({snapshot.parseError}). This is the
          last valid version; fix the text to edit again.
        </span>
        <button type="button" onClick={() => send({ type: 'openText' })}>
          Open in Text Editor
        </button>
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
    if (open) reveal(open.node);
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

/**
 * A format 1 flow (AFD-49): what Upgrade Flow Format would change, and the button. Shown while the
 * flow can be edited; closing it hides it for this panel. Nothing is upgraded without asking.
 */
export function FormatBanner() {
  const doc = useUi((s) => s.snapshot?.doc);
  const dismissed = useUi((s) => s.formatDismissed);
  const editable = useEditable();
  if (!doc || dismissed || !editable || formatOf(doc) >= CURRENT_FORMAT) return null;
  const notes = upgradeNotes(doc);
  const upgrade = async () => {
    const ack = await run({ kind: 'upgradeFormat' });
    if (ack.ok)
      useUi
        .getState()
        .notify('success', `Upgraded to flow format ${CURRENT_FORMAT}. Undo reverts it.`);
  };
  return (
    <div className="afd-banner info" role="status" data-format-banner={formatOf(doc)}>
      <span className="codicon codicon-arrow-circle-up" aria-hidden="true" />
      <span>
        <strong>Flow format {formatOf(doc)}.</strong>{' '}
        {notes.length
          ? `Upgrading changes: ${notes.join('; ')}.`
          : `Format ${CURRENT_FORMAT} is what newer features use; the design stays as it is.`}{' '}
        One undo step reverts it.
      </span>
      <button type="button" onClick={() => void upgrade()}>
        Upgrade Flow Format
      </button>
      <button
        type="button"
        className="icon"
        aria-label="Hide the format message"
        title="Hide"
        onClick={() => useUi.setState({ formatDismissed: true })}
      >
        <span className="codicon codicon-close" aria-hidden="true" />
      </button>
    </div>
  );
}

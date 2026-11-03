// Open fail port banner (D-15): count of open fail-type ports not marked open on purpose;
// dismissing hides it until the count changes. AFD-72: it asks what should happen when the step
// fails, with the first fixes as buttons; Next walks the open ports. A flow written by hand without
// IDs (AFD-19) shows Complete IDs here first: the canvas edits after it.
import { useState } from 'react';
import { CURRENT_FORMAT, formatOf, upgradeNotes } from '../../core/flow/migrate';
import { modelOf } from '../../core/flow/model';
import { portMenu } from '../../core/flow/portMenu';
import { run } from '../actions';
import { send } from '../bus';
import { menuAnchor } from '../canvas/FlowNodeView';
import { useEditable } from '../editActions';
import { runPortItem } from '../portActions';
import { useUi } from '../store';
import { bannerCount } from '../viewModel';

/** How the question names the failure, per port. */
const FAILS: Record<string, string> = {
  failed_hosts: 'fails',
  unreachable: 'cannot reach a host',
  timeout: 'runs out of time',
  rejected: 'is rejected',
};

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
  return <OpenPortsBanner reveal={reveal} dismiss={dismiss} dismissedAt={dismissedAt} />;
}

function OpenPortsBanner({
  reveal,
  dismiss,
  dismissedAt,
}: {
  reveal: (node: string) => void;
  dismiss: (count: number) => void;
  dismissedAt: number | null;
}) {
  const snapshot = useUi((s) => s.snapshot);
  const editable = useEditable();
  const [at, setAt] = useState(0);
  const count = snapshot ? bannerCount(snapshot.openPorts) : 0;
  if (!snapshot?.doc || count === 0 || dismissedAt === count)
    return <span hidden data-banner-count={count} />;
  const open = snapshot.openPorts[at % count];
  const model = modelOf(snapshot.doc);
  const node = open ? model?.nodes.get(open.node)?.node : undefined;
  const ref = open ? { node: open.node, port: open.port } : undefined;
  const items = ref && model && editable ? (portMenu(model, ref)?.items ?? []) : [];
  const quick = [
    ...items.filter((i) => i.kind === 'pattern').slice(0, 2),
    ...items.filter((i) => i.kind === 'decide'),
  ];
  // The rest of the choices: the port's own menu, beside the port once it is on screen.
  const others = () => {
    if (!ref) return;
    reveal(ref.node);
    setTimeout(() => {
      const el = document.querySelector(
        `.react-flow__node[data-id="${ref.node}"] [data-port="${ref.port}"]`,
      );
      if (el) useUi.getState().openPortMenu({ ref, ...menuAnchor(el, 'right') });
    }, 300);
  };
  return (
    <div className="afd-banner warning" role="status" data-banner-count={count}>
      <span className="codicon codicon-warning" aria-hidden="true" />
      <strong>
        {count} open fail port{count === 1 ? '' : 's'}
      </strong>
      <span title="Hosts that fail there have nowhere to go, so they fail the run">
        What should happen when{' '}
        <button type="button" className="link" onClick={() => open && reveal(open.node)}>
          "{node?.title ?? open?.node}"
        </button>{' '}
        {FAILS[open?.port ?? ''] ?? `takes ${open?.port}`}?
      </span>
      {ref
        ? quick.map((item) => (
            <button
              key={item.label}
              type="button"
              className="secondary"
              title={'hint' in item ? item.hint : undefined}
              onClick={() => void runPortItem(item, ref)}
            >
              {item.label}
            </button>
          ))
        : null}
      {editable ? (
        <button type="button" className="link" onClick={others}>
          Other Choices
        </button>
      ) : null}
      {count > 1 ? (
        <button
          type="button"
          className="link"
          onClick={() => {
            const next = snapshot.openPorts[(at + 1) % count];
            setAt(at + 1);
            if (next) reveal(next.node);
          }}
        >
          Next ({((at + 1) % count) + 1} of {count})
        </button>
      ) : null}
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

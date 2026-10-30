// Right panel for several selected nodes (AFD-7): what is selected, and Extract into subflow. The
// command checks the selection (one way in, exits, connected); a refusal is shown here.
import { useState } from 'react';
import { slugify } from '../../core/flow/ids';
import { buildModel } from '../../core/flow/model';
import type { FlowNode, Ulid } from '../../core/flow/types';
import { command } from '../bus';
import { useUi } from '../store';

export function SelectionPanel({ ids }: { ids: Ulid[] }) {
  const snapshot = useUi((s) => s.snapshot);
  const select = useUi((s) => s.select);
  const [title, setTitle] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const doc = snapshot?.doc;
  if (!doc) return null;
  const model = buildModel(doc);
  const nodes = ids.map((id) => model.nodes.get(id)?.node).filter((n): n is FlowNode => !!n);
  const name = title.trim() || 'Subflow';
  const at = nodes
    .map((n) => doc.layout?.[n.id] ?? snapshot?.autoPositions[n.id])
    .filter((p): p is { x: number; y: number } => !!p);
  const extract = async () => {
    setBusy(true);
    setError(null);
    const ack = await command({
      kind: 'extractSubflow',
      nodes: ids,
      title: name,
      ...(at.length > 0
        ? { position: { x: Math.min(...at.map((p) => p.x)), y: Math.min(...at.map((p) => p.y)) } }
        : {}),
    });
    setBusy(false);
    if (!ack.ok) setError(ack.error ?? 'The nodes could not be extracted');
    else if (ack.created) select({ node: ack.created });
  };
  return (
    <div className="afd-panel-body" data-selection-panel={nodes.length}>
      <h2 className="afd-panel-title">
        {nodes.length} node{nodes.length === 1 ? '' : 's'} selected
      </h2>
      <ul className="afd-selection-list">
        {nodes.map((n) => (
          <li key={n.id}>
            {n.title} <span className="mono muted">{n.key}</span>
          </li>
        ))}
      </ul>
      <section className="afd-section">
        <h3>Extract into subflow</h3>
        <p className="muted">
          The nodes and the wires between them move into a new subflow, with their IDs. Wires into
          the selection must reach one node; wires out leave through the subflow's ports.
        </p>
        <label className="afd-field">
          <span className="afd-label">Title</span>
          <input
            type="text"
            value={title}
            placeholder="Subflow"
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !busy) void extract();
            }}
          />
        </label>
        <p className="muted">
          Key <span className="mono">{slugify(name, 'subflow')}</span>
        </p>
        <button type="button" disabled={busy} onClick={() => void extract()}>
          <span className="codicon codicon-type-hierarchy-sub" aria-hidden="true" /> Extract into
          subflow
        </button>
        {error ? (
          <p className="afd-run-warning" role="alert" data-extract-error>
            <span className="codicon codicon-warning" aria-hidden="true" /> {error}
          </p>
        ) : null}
      </section>
    </div>
  );
}

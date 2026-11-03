// Right panel for a selected wire in Design mode (AFD-72): which hosts take it, in plain words, and
// what can be done with it (the wired port's own menu).
import { modelOf } from '../../core/flow/model';
import { portMenu } from '../../core/flow/portMenu';
import { portHint } from '../../core/view/portHints';
import { useEditable } from '../editActions';
import { runPortItem } from '../portActions';
import { useUi } from '../store';

export function WirePanel({ edge }: { edge: string }) {
  const doc = useUi((s) => s.snapshot?.doc);
  const editable = useEditable();
  const model = doc ? modelOf(doc) : undefined;
  const wire = model?.edges.get(edge)?.edge;
  if (!model || !wire) return null;
  const from = model.nodes.get(wire.from.node)?.node;
  const to = model.nodes.get(wire.to.node)?.node;
  const ref = { node: wire.from.node, port: wire.from.port };
  const hint = portHint(wire.from.port, from?.type);
  const items = editable ? (portMenu(model, ref)?.items ?? []) : [];
  return (
    <div className="afd-panel-body" data-wire-panel={edge}>
      <h2>Wire</h2>
      <p>
        Hosts that leave <strong>{from?.title}</strong> by{' '}
        <span className="mono">{wire.from.port}</span> go to <strong>{to?.title}</strong>.
      </p>
      {hint ? <p className="muted">{hint}.</p> : null}
      <div className="afd-panel-actions">
        {items.map((item) => (
          <button
            key={item.label}
            type="button"
            className="secondary"
            onClick={() => void runPortItem(item, ref)}
          >
            {item.label}
          </button>
        ))}
      </div>
    </div>
  );
}

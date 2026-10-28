// Node inspector (04 §5, mockup 03): identity, lifecycle stepper with the next requirement,
// contract, every port of the type with its state and resolution actions (the same items as the
// canvas port menu), and the implementation summary with the skeleton stub.
import { SLUG } from '../../core/flow/ids';
import { buildModel, type FlowModel } from '../../core/flow/model';
import { portMenu } from '../../core/flow/portMenu';
import type { FlowNode, HandlerKind, NodeStatus } from '../../core/flow/types';
import { run } from '../actions';
import { send } from '../bus';
import { STATE_LABEL, TYPE_LABEL } from '../canvas/FlowNodeView';
import { runPortItem } from '../portActions';
import { useUi } from '../store';
import type { PortView } from '../viewModel';
import { levelView, nextRequirement, STATUS_ORDER, skeletonStub } from '../viewModel';
import { ContractEditor } from './ContractEditor';
import { CommitField, ReadOnly } from './fields';

const HANDLERS: (HandlerKind | '')[] = ['', 'rollback', 'notify', 'retry', 'exclude'];

export function Inspector({ id }: { id: string }) {
  const snapshot = useUi((s) => s.snapshot);
  if (!snapshot?.doc) return null;
  const model = buildModel(snapshot.doc);
  const entry = model.nodes.get(id);
  if (!entry) return null;
  const node = entry.node;
  const view = levelView(snapshot).nodes.find((n) => n.node.id === id);
  const patch = (p: Parameters<typeof updatePatch>[1]) => void updatePatch(id, p);
  const titleOf = (nid: string) => model.nodes.get(nid)?.node.title ?? nid;
  const edges = model.levels.get(entry.level)?.edges ?? [];
  const decisions = snapshot.doc.decisions ?? [];
  const designable = node.type !== 'start' && node.type !== 'end';

  return (
    <div className="afd-panel-body" data-inspector={id}>
      <div className="afd-inspector-head">
        <span className="afd-chip">{TYPE_LABEL[node.type]}</span>
        <button
          type="button"
          className="icon"
          title="Show in text"
          aria-label="Show in text"
          onClick={() => send({ type: 'openText', path: entry.path })}
        >
          <span className="codicon codicon-go-to-file" aria-hidden="true" />
        </button>
        <button
          type="button"
          className="icon"
          title="Delete node"
          aria-label="Delete node"
          onClick={() => void run({ kind: 'deleteNode', id })}
        >
          <span className="codicon codicon-trash" aria-hidden="true" />
        </button>
      </div>
      <CommitField
        label="Title"
        value={node.title}
        onCommit={(v) => patch({ title: v })}
        validate={(v) => (v.trim() ? undefined : 'Required')}
      />

      <section className="afd-section">
        <h3>Identity</h3>
        <ReadOnly label="ID (fixed)" value={node.id} mono />
        <CommitField
          label="Key"
          value={node.key}
          mono
          onCommit={(v) => patch({ key: v })}
          validate={(v) => (SLUG.test(v) ? undefined : 'Lowercase words joined by dashes')}
        />
        {designable ? (
          <CommitField
            label="Intent"
            value={node.intent ?? ''}
            multiline
            onCommit={(v) => patch({ intent: v.trim() ? v : null })}
          />
        ) : null}
      </section>

      {designable ? <Lifecycle node={node} onSet={(status) => patch({ status })} /> : null}
      <TypeFields node={node} patch={patch} />

      {designable ? (
        <>
          <ContractEditor
            title="Inputs"
            target={id}
            side="inputs"
            contract={node.inputs}
            withFrom
          />
          <ContractEditor
            title="Outputs"
            target={id}
            side="outputs"
            contract={node.outputs}
            withFrom
          />
        </>
      ) : null}

      <section className="afd-section">
        <h3>Ports</h3>
        <ul className="afd-ports">
          {view?.ports.map((p) => (
            <PortRow
              key={p.name}
              model={model}
              node={id}
              port={p}
              target={titleOf(
                edges.find((e) => e?.from?.node === id && e.from.port === p.name)?.to.node ?? '',
              )}
              reason={decisions.find((d) => d?.node === id && d.port === p.name)?.reason}
            />
          ))}
        </ul>
      </section>

      {designable ? (
        <section className="afd-section">
          <h3>Implementation</h3>
          {node.impl ? (
            <p>
              <span className="afd-chip">{node.impl.kind}</span>{' '}
              <span className="mono">{node.impl.ref}</span>
              {node.impl.collection_version ? (
                <span className="muted"> {node.impl.collection_version}</span>
              ) : null}
            </p>
          ) : (
            <>
              <p className="muted">Not bound. As a walking skeleton this node runs:</p>
              <pre className="afd-code">{skeletonStub(node)}</pre>
            </>
          )}
          <button type="button" disabled title="Binding arrives in M5">
            Bind module, role or playbook
          </button>
        </section>
      ) : null}
    </div>
  );
}

function updatePatch(id: string, p: Record<string, unknown>) {
  return run({ kind: 'updateNode', id, patch: p });
}

function Lifecycle({ node, onSet }: { node: FlowNode; onSet(s: NodeStatus): void }) {
  const status = node.status ?? 'draft';
  const current = STATUS_ORDER.indexOf(status);
  const next = nextRequirement(node);
  return (
    <section className="afd-section">
      <h3>Lifecycle</h3>
      <ol className="afd-stepper">
        {STATUS_ORDER.map((s, i) => (
          <li key={s} className={i < current ? 'done' : i === current ? 'current' : ''}>
            <button
              type="button"
              onClick={() => onSet(s)}
              aria-current={i === current ? 'step' : undefined}
              title={`Set status to ${s}`}
            >
              {s}
            </button>
          </li>
        ))}
      </ol>
      {next ? <p className="muted">Next: {next}</p> : null}
    </section>
  );
}

function TypeFields({ node, patch }: { node: FlowNode; patch(p: Record<string, unknown>): void }) {
  switch (node.type) {
    case 'decision':
      return (
        <CommitField
          label="Condition (evaluated per host)"
          value={node.condition ?? ''}
          mono
          onCommit={(v) => patch({ condition: v.trim() ? v : null })}
        />
      );
    case 'end':
      return (
        <div className="afd-field">
          <label htmlFor="afd-outcome">Outcome</label>
          <select
            id="afd-outcome"
            value={node.outcome ?? 'success'}
            onChange={(e) => patch({ outcome: e.target.value })}
          >
            <option value="success">success</option>
            <option value="failed">failed</option>
          </select>
        </div>
      );
    case 'join':
      return (
        <div className="afd-field">
          <label htmlFor="afd-join">Join mode (per host)</label>
          <select
            id="afd-join"
            value={node.join_mode ?? 'all'}
            onChange={(e) => patch({ join_mode: e.target.value })}
          >
            <option value="all">all: every branch delivered the host</option>
            <option value="any">any: at least one branch</option>
          </select>
        </div>
      );
    case 'parallel':
      return (
        <CommitField
          label="Branches"
          value={String(node.branches ?? 2)}
          onCommit={(v) => patch({ branches: Number(v) })}
          validate={(v) => (/^[0-9]+$/.test(v) && Number(v) >= 2 ? undefined : 'At least 2')}
        />
      );
    case 'task':
    case 'subflow':
      return (
        <div className="afd-field">
          <label htmlFor="afd-handler">Failure handler role</label>
          <select
            id="afd-handler"
            value={node.handler ?? ''}
            onChange={(e) => patch({ handler: e.target.value || null })}
          >
            {HANDLERS.map((h) => (
              <option key={h} value={h}>
                {h || 'none'}
              </option>
            ))}
          </select>
        </div>
      );
    default:
      return null;
  }
}

/** One port: state, where it leads, a menu button, and quick resolutions for open fail ports. */
function PortRow({
  model,
  node,
  port,
  target,
  reason,
}: {
  model: FlowModel;
  node: string;
  port: PortView;
  target: string;
  reason?: string;
}) {
  const openPortMenu = useUi((s) => s.openPortMenu);
  const ref = { node, port: port.name };
  const wired = port.state === 'connected' && port.direction === 'out';
  let text: string = STATE_LABEL[port.state];
  if (wired) text = `→ ${target}`;
  else if (reason) text = `${STATE_LABEL[port.state]}: ${reason}`;
  else if (port.state === 'open-fail') text = 'open: needs a handler or a decision';
  // Mockup 03: the first suggestions inline, plus "Leave open on purpose…".
  const quick =
    port.state === 'open-fail'
      ? (portMenu(model, ref)?.items ?? []).filter(
          (i, n) => (i.kind === 'pattern' && n < 2) || i.kind === 'decide',
        )
      : [];
  return (
    <li className={`state-${port.state}`} data-port-row={port.name}>
      <span
        className={`afd-swatch port state-${port.state} tone-${port.tone}`}
        aria-hidden="true"
      />
      <span className="mono">{port.name}</span>
      <span className="muted">{text}</span>
      <button
        type="button"
        className="icon"
        aria-label={`Options for port ${port.name}`}
        title="Options"
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          openPortMenu({ ref, x: r.left - 230, y: r.bottom + 4 });
        }}
      >
        <span className="codicon codicon-ellipsis" aria-hidden="true" />
      </button>
      {quick.length > 0 ? (
        <span className="afd-port-quick">
          {quick.map((item) => (
            <button
              key={item.label}
              type="button"
              className="link"
              onClick={() => void runPortItem(item, ref)}
            >
              {item.label}
            </button>
          ))}
        </span>
      ) : null}
    </li>
  );
}

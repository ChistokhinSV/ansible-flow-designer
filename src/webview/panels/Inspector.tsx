// Node inspector (04 §5, mockup 03): identity, lifecycle stepper with the next requirement,
// contract, ports with their state, and the implementation summary with the skeleton stub.
import { SLUG } from '../../core/flow/ids';
import { buildModel } from '../../core/flow/model';
import { optionalPortNames } from '../../core/flow/ports';
import type { FlowNode, HandlerKind, NodeStatus } from '../../core/flow/types';
import { run } from '../actions';
import { send } from '../bus';
import { TYPE_LABEL } from '../canvas/FlowNodeView';
import { useUi } from '../store';
import { levelView, nextRequirement, STATUS_ORDER, skeletonStub } from '../viewModel';
import { ContractEditor } from './ContractEditor';
import { CommitField, ReadOnly } from './fields';

const HANDLERS: (HandlerKind | '')[] = ['', 'rollback', 'notify', 'retry', 'exclude'];
const STATE_TEXT = {
  connected: 'wired',
  'open-fail': 'open: needs a handler or a decision',
  'open-purpose': 'open on purpose',
  open: 'open',
} as const;

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
          {view?.ports.map((p) => {
            const out = edges.find((e) => e?.from?.node === id && e.from.port === p.name);
            const decision = decisions.find((d) => d?.node === id && d.port === p.name);
            return (
              <li key={p.name} className={`state-${p.state}`}>
                <span
                  className={`afd-swatch port state-${p.state} tone-${p.tone}`}
                  aria-hidden="true"
                />
                <span className="mono">{p.name}</span>
                <span className="muted">
                  {out ? `→ ${titleOf(out.to.node)}` : STATE_TEXT[p.state]}
                  {decision?.reason ? `: ${decision.reason}` : ''}
                </span>
                {p.optional && p.state !== 'connected' ? (
                  <button
                    type="button"
                    className="link"
                    onClick={() =>
                      void run({ kind: 'setPortEnabled', node: id, port: p.name, enabled: false })
                    }
                  >
                    disable
                  </button>
                ) : null}
              </li>
            );
          })}
        </ul>
        <OptionalPorts node={node} />
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

function OptionalPorts({ node }: { node: FlowNode }) {
  const available = optionalPortNames(node.type).filter((p) => !node.ports?.includes(p));
  if (available.length === 0) return null;
  return (
    <div className="afd-optional-ports">
      <span className="muted">Enable:</span>
      {available.map((p) => (
        <button
          key={p}
          type="button"
          className="chip-button mono"
          onClick={() =>
            void run({ kind: 'setPortEnabled', node: node.id, port: p, enabled: true })
          }
        >
          + {p}
        </button>
      ))}
    </div>
  );
}

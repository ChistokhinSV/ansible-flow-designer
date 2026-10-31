// Node inspector (04 §5, mockup 03): identity, lifecycle stepper with the next requirement,
// contract, every port of the type with its state and resolution actions (the same items as the
// canvas port menu), the implementation with the play it generates (ADR-0009), and what the last
// skeleton run sent through each port.
import { SLUG } from '../../core/flow/ids';
import { buildModel, type FlowModel } from '../../core/flow/model';
import { portMenu } from '../../core/flow/portMenu';
import type { FlowNode, HandlerKind, NodeStatus } from '../../core/flow/types';
import { run } from '../actions';
import { send } from '../bus';
import { STATE_LABEL, TYPE_LABEL } from '../canvas/FlowNodeView';
import { copySelection } from '../clipboard';
import { deleteSelection, useEditable } from '../editActions';
import { runPortItem } from '../portActions';
import { keysOf } from '../shortcuts';
import { useUi } from '../store';
import type { PortView } from '../viewModel';
import { levelView, nextRequirement, STATUS_ORDER, skeletonStub } from '../viewModel';
import { ContractEditor } from './ContractEditor';
import { CommitField, ReadOnly } from './fields';

const HANDLERS: (HandlerKind | '')[] = ['', 'rollback', 'notify', 'retry', 'exclude'];

/**
 * A node's inspector; `context` when it describes the subflow whose level is open and nothing is
 * selected (AFD-30). Fields are read-only while the flow text cannot take edits.
 */
export function Inspector({ id, context }: { id: string; context?: boolean }) {
  const snapshot = useUi((s) => s.snapshot);
  const editable = useEditable();
  if (!snapshot?.doc) return null;
  const model = buildModel(snapshot.doc);
  const entry = model.nodes.get(id);
  if (!entry) return null;
  const node = entry.node;
  const view = levelView(snapshot, {}, entry.level).nodes.find((n) => n.node.id === id);
  const patch = (p: Parameters<typeof updatePatch>[1]) => void updatePatch(id, p);
  const titleOf = (nid: string) => model.nodes.get(nid)?.node.title ?? nid;
  const edges = model.levels.get(entry.level)?.edges ?? [];
  const decisions = snapshot.doc.decisions ?? [];
  const designable = node.type !== 'start' && node.type !== 'end';
  const play = snapshot.plays?.[id];

  return (
    <div className="afd-panel-body" data-inspector={id}>
      <div className="afd-inspector-head">
        <span className="afd-chip">{TYPE_LABEL[node.type]}</span>
        <button
          type="button"
          className="icon"
          title="Properties"
          aria-label="Open properties"
          onClick={() => useUi.getState().openProperties(id)}
        >
          <span className="codicon codicon-settings-gear" aria-hidden="true" />
        </button>
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
          title={`Copy (${keysOf('copy')}): paste on a flow (${keysOf('paste')}) or in a text file`}
          aria-label="Copy node"
          onClick={() => copySelection()}
        >
          <span className="codicon codicon-copy" aria-hidden="true" />
        </button>
        <button
          type="button"
          className="icon"
          title="Delete node"
          aria-label="Delete node"
          onClick={() => void deleteSelection([id])}
        >
          <span className="codicon codicon-trash" aria-hidden="true" />
        </button>
      </div>
      {context ? (
        <p className="muted" data-level-context={id}>
          You are inside this subflow. Select a step to edit it; the subflow itself is described
          here.
        </p>
      ) : null}
      <fieldset className="afd-editable" disabled={!editable}>
        <CommitField
          label="Title"
          focusKey="title"
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
              <p className="muted">
                Not bound: as a walking skeleton this node runs a TODO message.
              </p>
            )}
            <details className="afd-generated" open={!node.impl}>
              <summary>Generated play</summary>
              <pre className="afd-code" data-generated-play={id}>
                {play ??
                  (node.type === 'task' || node.type === 'subflow'
                    ? skeletonStub(node)
                    : 'Fix the errors in this flow to see the generated code')}
              </pre>
            </details>
            <button
              type="button"
              data-bind={id}
              onClick={() => useUi.getState().openProperties(id, 'implementation')}
            >
              <span className="codicon codicon-plug" aria-hidden="true" />
              {node.impl ? 'Change binding…' : 'Bind module, role or playbook…'}
            </button>
          </section>
        ) : null}
      </fieldset>
      {node.type === 'subflow' && !context ? (
        <section className="afd-section">
          <h3>Inner steps</h3>
          <p className="muted">
            {node.subflow?.nodes?.length
              ? `${node.subflow.nodes.length} step(s) inside.`
              : 'No inner steps yet: open it and add the first one.'}
          </p>
          <button type="button" onClick={() => useUi.getState().setLevel(id)}>
            <span className="codicon codicon-arrow-right" aria-hidden="true" /> Open subflow
          </button>
        </section>
      ) : null}
      <LastRun id={id} />
    </div>
  );
}

/** Hosts the last run sent through each port of this node (M3; Run mode in M7). */
function LastRun({ id }: { id: string }) {
  const run = useUi((s) => s.run);
  const ports = run?.summary?.nodes[id];
  const failures = run?.summary?.failures.filter((f) => f.node === id) ?? [];
  if (run?.state !== 'done' || (!ports && failures.length === 0)) return null;
  return (
    <section className="afd-section" data-last-run={id}>
      <h3>Last {run.mode === 'check' ? 'skeleton run' : 'run'}</h3>
      <ul className="afd-run-ports">
        {Object.entries(ports ?? {}).map(([port, hosts]) => (
          <li key={port} title={hosts.join(', ')}>
            <span className="mono">{port}</span> <span className="afd-chip">{hosts.length}</span>{' '}
            <span className="muted">
              {hosts.slice(0, 4).join(', ')}
              {hosts.length > 4 ? ', …' : ''}
            </span>
          </li>
        ))}
        {failures.map((f) => (
          <li key={`${f.host}|${f.task}`} className="afd-run-failure">
            <span className="codicon codicon-error" aria-hidden="true" /> {f.host}:{' '}
            {f.msg ?? f.task}
          </li>
        ))}
      </ul>
    </section>
  );
}

export function updatePatch(id: string, p: Record<string, unknown>) {
  return run({ kind: 'updateNode', id, patch: p });
}

export function Lifecycle({ node, onSet }: { node: FlowNode; onSet(s: NodeStatus): void }) {
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

export function TypeFields({
  node,
  patch,
}: {
  node: FlowNode;
  patch(p: Record<string, unknown>): void;
}) {
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
export function PortRow({
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

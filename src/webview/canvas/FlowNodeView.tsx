// Node on the canvas: a cheap shell with ports, plus a memoized body (07 §6). Semantic zoom
// (D-19): below zoom 0.45 the body collapses to the title only ("far"); at default zoom it shows
// the status dot and at most two chips (the active lens's, M8); from zoom 1.4 the box lists summary
// rows, and a selected node opens its summary card below it.
// Ports follow D-14: every port of the type is rendered (so wires can reach them and positions stay
// fixed), but at rest only connected, open-fail and open-on-purpose ports show; hover, selection,
// an open port menu or a wire being dragged reveal the rest with labels (CSS in styles.css).
import {
  Handle,
  type Node,
  type NodeProps,
  Position,
  type ReactFlowState,
  useStore,
  useUpdateNodeInternals,
} from '@xyflow/react';
import { Fragment, type MouseEvent, memo, useEffect, useMemo, useRef } from 'react';
import type { PortSide } from '../../core/flow/ports';
import type { FlowNode, NodeType, Ulid } from '../../core/flow/types';
import { summaryRows } from '../../core/lens';
import { formatSeconds } from '../../core/run/view';
import { send } from '../bus';
import { useUi } from '../store';
import type { NodeView, PortState, PortView } from '../viewModel';

export type FlowNodeData = { view: NodeView };
export type FlowRFNode = Node<FlowNodeData, 'flow'>;

const SIDE: Record<PortSide, Position> = {
  top: Position.Top,
  bottom: Position.Bottom,
  left: Position.Left,
  right: Position.Right,
};

export const TYPE_LABEL: Record<NodeType, string> = {
  start: 'Start',
  end: 'End',
  task: 'Task',
  subflow: 'Subflow',
  decision: 'Decision',
  approval: 'Approval',
  parallel: 'Parallel',
  join: 'Join',
};

export const STATE_LABEL: Record<PortState, string> = {
  connected: 'connected',
  'open-fail': 'open: not handled',
  'open-purpose': 'open on purpose',
  open: 'open',
  available: 'optional, not enabled',
};

const farSelector = (s: ReactFlowState) => s.transform[2] < 0.45;
/** D-19 "near": from this zoom the node box lists summary rows. */
export const NEAR_ZOOM = 1.4;
const nearSelector = (s: ReactFlowState) => s.transform[2] >= NEAR_ZOOM;
const isWork = (n: FlowNode) => n.type !== 'start' && n.type !== 'end';

/** Window point next to a port where its menu opens. */
export function menuAnchor(el: Element, side: PortSide): { x: number; y: number } {
  const r = el.getBoundingClientRect();
  if (side === 'left') return { x: r.left - 8, y: r.top - 8 };
  if (side === 'bottom') return { x: r.left - 8, y: r.bottom + 8 };
  return { x: r.right + 8, y: r.top - 8 };
}

function PortHandle({ nodeId, port }: { nodeId: string; port: PortView }) {
  const openPortMenu = useUi((s) => s.openPortMenu);
  const along = `${Math.round(port.offset * 100)}%`;
  const style = port.side === 'top' || port.side === 'bottom' ? { left: along } : { top: along };
  const isOutput = port.direction === 'out';
  // Run mode shows results; wiring and port menus belong to Design.
  const locked = useUi((s) => s.mode === 'run');
  const onClick = (e: MouseEvent<HTMLDivElement>) => {
    // While picking a target, the click belongs to the node (FlowCanvas onNodeClick).
    if (useUi.getState().pick || locked) return;
    const at = menuAnchor(e.currentTarget, port.side);
    openPortMenu({ ref: { node: nodeId, port: port.name }, ...at });
  };
  return (
    <Handle
      id={port.name}
      type={isOutput ? 'source' : 'target'}
      position={SIDE[port.side]}
      isConnectable={!locked}
      // One edge per output port (03): a wired output cannot start another wire.
      isConnectableStart={isOutput && port.state !== 'connected'}
      isConnectableEnd={!isOutput}
      className={[
        'afd-port',
        `state-${port.state}`,
        `tone-${port.tone}`,
        `side-${port.side}`,
        port.optional ? 'optional' : '',
        port.rest ? 'rest' : 'reveal',
      ]
        .filter(Boolean)
        .join(' ')}
      style={style}
      data-port={port.name}
      data-port-state={port.state}
      data-rest={port.rest ? 'true' : undefined}
      title={`${port.name} · ${STATE_LABEL[port.state]} · click for options`}
      aria-label={`Port ${port.name}, ${STATE_LABEL[port.state]}`}
      onClick={onClick}
    >
      <span className="afd-port-label" aria-hidden="true">
        {port.name}
      </span>
    </Handle>
  );
}

/** Implementation mode (mockup 04): what the node runs and how it stands against the code. */
function CodeLines({ node }: { node: FlowNode }) {
  const code = useUi((s) => s.drift?.nodes[node.id]);
  const issue = useUi((s) =>
    s.drift?.items.find((i) => i.node === node.id && !i.ignored && i.severity === 'warning'),
  );
  const ran = useUi((s) => (s.run?.state === 'done' ? s.run.summary : undefined));
  if (!code) return <div className="afd-node-sub muted">not synced</div>;
  const inner = node.type === 'subflow' && (node.subflow?.nodes?.length ?? 0) > 0;
  const count = `${code.tasks.length} task${code.tasks.length === 1 ? '' : 's'}`;
  let state: string;
  let tone = 'ok';
  if (issue) {
    state = `drift: ${issue.label}`;
    tone = 'warn';
  } else if (!node.impl?.ref && !inner && (node.type === 'task' || node.type === 'subflow')) {
    state = 'runs as TODO stub';
    tone = 'neutral';
  } else if (ran?.failures.some((f) => f.node === node.id)) {
    state = 'last run failed';
    tone = 'warn';
  } else if (ran?.nodes[node.id]) state = 'last run ok';
  else if (inner) {
    state = 'open subflow';
    tone = 'neutral';
  } else {
    state = code.matched ? 'matched by ID' : 'not in generated code';
    tone = code.matched ? 'neutral' : 'warn';
  }
  return (
    <>
      <div className="afd-node-sub mono afd-node-artifact" title={code.artifact}>
        {code.artifact}
      </div>
      <div className={`afd-node-code tone-${tone}`} data-code-state={state}>
        {code.artifact === 'not bound' ? state : `${count} · ${state}`}
      </div>
    </>
  );
}

/** Run mode (04 §10): how many hosts the node handled, how many failed, how long it took. */
function RunLine({ node }: { node: FlowNode }) {
  const r = useUi((s) => s.runNodes?.[node.id]);
  const running = useUi((s) => s.run?.state === 'running');
  // An AWX approval (AFD-11): its decision, and how many hosts it decided for.
  const approval = useUi((s) => s.run?.awx?.approvals?.[node.id]);
  if (approval) {
    const hosts = r && r.state !== 'idle' ? ` · ${r.hosts} host${r.hosts === 1 ? '' : 's'}` : '';
    const tone = approval.status === 'approved' ? 'ok' : 'warn';
    return (
      <div className={`afd-node-run tone-${tone}`} data-approval={approval.status}>
        {approval.status === 'waiting' ? 'waiting for approval' : approval.status}
        {hosts}
      </div>
    );
  }
  if (!r) return <div className="afd-node-run tone-neutral">{running ? 'waiting' : 'no run'}</div>;
  if (r.state === 'idle')
    return (
      <div className="afd-node-run tone-neutral" data-run-state="idle">
        {running ? 'waiting' : 'not reached'}
      </div>
    );
  const parts = [`${r.hosts} host${r.hosts === 1 ? '' : 's'}`];
  if (r.failed > 0) parts.push(`${r.failed} failed`);
  if (r.seconds !== undefined) parts.push(formatSeconds(r.seconds));
  const tone = r.state === 'ok' ? 'ok' : 'warn';
  return (
    <div className={`afd-node-run tone-${tone}`} data-run-state={r.state}>
      {parts.join(' · ')}
    </div>
  );
}

/** The active lens's chips for a node (D-18, D-19: two at most). */
function LensChips({ id }: { id: Ulid }) {
  const lens = useUi((s) => s.lens);
  const chips = useUi((s) => s.lensView?.chips[id]);
  if (!lens) return null;
  return (
    <div
      className={`afd-chips afd-lens-chips lens-${lens}`}
      data-lens-chips={(chips ?? []).map((c) => c.text).join('|')}
    >
      {(chips ?? []).map((c) => (
        <span
          key={c.text}
          className={`afd-chip afd-lens-chip${c.tone ? ` tone-${c.tone}` : ''}`}
          title={c.title}
        >
          {c.text}
        </span>
      ))}
    </div>
  );
}

function useSummary(node: FlowNode) {
  const doc = useUi((s) => s.snapshot?.doc);
  const facts = useUi((s) => s.lensFacts);
  const run = useUi((s) => s.run);
  return useMemo(() => (doc ? summaryRows(doc, node, facts, run) : []), [doc, node, facts, run]);
}

function SummaryRows({
  node,
  max,
  className,
}: {
  node: FlowNode;
  max?: number;
  className: string;
}) {
  const rows = useSummary(node);
  if (rows.length === 0) return null;
  return (
    <dl className={className}>
      {rows.slice(0, max).map((r) => (
        <Fragment key={r.label}>
          <dt>{r.label}</dt>
          <dd title={r.value}>{r.value}</dd>
        </Fragment>
      ))}
    </dl>
  );
}

/** D-19 "selected": the compact summary card under the node, with its actions. */
function SummaryCard({ node }: { node: FlowNode }) {
  const setLevel = useUi((s) => s.setLevel);
  const openProperties = useUi((s) => s.openProperties);
  const hasPlay = useUi((s) => !!s.snapshot?.plays?.[node.id]);
  const status = node.status ?? 'draft';
  return (
    // nodrag/nopan: the card is clickable without moving the node or the view.
    <div className="afd-summary-card nodrag nopan" data-summary-card={node.id}>
      <div className="afd-summary-head">
        <span className={`afd-dot status-${status}`} aria-hidden="true" />
        <strong>{node.title}</strong>
        <span className="muted">
          {TYPE_LABEL[node.type]} · {status}
        </span>
      </div>
      <SummaryRows node={node} className="afd-summary-rows" />
      <div className="afd-summary-actions">
        {node.type === 'subflow' ? (
          <button type="button" className="link" onClick={() => setLevel(node.id)}>
            Open subflow
          </button>
        ) : null}
        {node.type === 'task' || node.type === 'subflow' ? (
          <button type="button" className="link" onClick={() => openProperties(node.id)}>
            Properties
          </button>
        ) : null}
        {hasPlay ? (
          <button
            type="button"
            className="link"
            onClick={() => send({ type: 'peekCode', node: node.id })}
          >
            Peek code
          </button>
        ) : null}
      </div>
    </div>
  );
}

const NodeBody = memo(function NodeBody({ node, near }: { node: FlowNode; near: boolean }) {
  const implementation = useUi((s) => s.mode === 'implementation');
  const runMode = useUi((s) => s.mode === 'run');
  const lens = useUi((s) => s.lens);
  if (node.type === 'start' || node.type === 'end') {
    return (
      <>
        <span className="afd-node-title">{node.title}</span>
        <LensChips id={node.id} />
      </>
    );
  }
  const status = node.status ?? 'draft';
  const head = (
    <div className="afd-node-head">
      <span className={`afd-dot status-${status}`} aria-hidden="true" />
      <span className="afd-node-title">{node.title}</span>
    </div>
  );
  if (near)
    return (
      <>
        {head}
        <LensChips id={node.id} />
        <SummaryRows node={node} max={lens ? 1 : 3} className="afd-node-summary" />
      </>
    );
  // A lens decides what the chips show, in every mode (D-18).
  if (lens)
    return (
      <>
        {head}
        <LensChips id={node.id} />
      </>
    );
  if (runMode)
    return (
      <>
        {head}
        <RunLine node={node} />
      </>
    );
  if (implementation)
    return (
      <>
        {head}
        <CodeLines node={node} />
      </>
    );
  const sub = [TYPE_LABEL[node.type], status, node.handler].filter(Boolean).join(' · ');
  return (
    <>
      {head}
      <div className="afd-node-sub">{sub}</div>
      {node.impl?.ref ? (
        <div className="afd-chips">
          <span className="afd-chip mono" title={node.impl.ref}>
            {node.impl.ref}
          </span>
        </div>
      ) : null}
    </>
  );
});

export const FlowNodeView = memo(function FlowNodeView({
  data,
  selected,
  dragging,
}: NodeProps<FlowRFNode>) {
  const far = useStore(farSelector);
  const near = useStore(nearSelector);
  const { node, ports } = data.view;
  const dataLens = useUi((s) => s.lens === 'data');
  // Handles added or removed after mount must be measured again before wires can attach. Only on a
  // toggle: re-measuring every node on mount upsets the initial fit of the view.
  const updateInternals = useUpdateNodeInternals();
  const shownData = useRef(dataLens);
  useEffect(() => {
    if (shownData.current === dataLens) return;
    shownData.current = dataLens;
    updateInternals(node.id);
  }, [dataLens, node.id, updateInternals]);
  const lensChips = useUi((s) =>
    s.lens ? (s.lensView?.chips[node.id] ?? []).map((c) => c.text).join('|') : undefined,
  );
  const lit = useUi((s) =>
    s.highlight ? (s.highlight.includes(node.id) ? 'lens-hit' : 'lens-dim') : '',
  );
  // D-14: the node stays active while its port menu is open, so its ports do not vanish.
  const active = useUi((s) => s.portMenu?.ref.node === node.id);
  const runMode = useUi((s) => s.mode === 'run');
  // A group selection (AFD-7) opens no summary cards: they would cover each other.
  const alone = useUi((s) => !s.selection.nodes);
  const runState = useUi((s) => (s.mode === 'run' ? s.runNodes?.[node.id]?.state : undefined));
  const classes = [
    runMode ? 'run-mode' : '',
    runState ? `run-${runState}` : '',
    'afd-node',
    `type-${node.type}`,
    `status-${node.status ?? 'draft'}`,
    node.handler ? 'handler' : '',
    node.type === 'end' && node.outcome === 'failed' ? 'outcome-failed' : '',
    selected ? 'selected' : '',
    active ? 'active' : '',
    lit,
  ]
    .filter(Boolean)
    .join(' ');
  return (
    // The lens chips are also on the root, so tests read them at any zoom (far hides the body).
    <div className={classes} data-node-id={node.id} data-run-state={runState} data-lens={lensChips}>
      {/* Hover margin around the node and its port labels (D-14 detail). */}
      <div className="afd-hover-zone" aria-hidden="true" />
      {ports.map((p) => (
        <PortHandle key={p.name} nodeId={node.id} port={p} />
      ))}
      {dataLens ? (
        <>
          {/* Data lens (decision 14): derived wires attach here, never to control ports. */}
          <Handle
            id="__data_in"
            type="target"
            position={Position.Left}
            isConnectable={false}
            className="afd-data-handle"
            style={{ top: '30%' }}
          />
          <Handle
            id="__data_out"
            type="source"
            position={Position.Right}
            isConnectable={false}
            className="afd-data-handle"
            style={{ top: '70%' }}
          />
        </>
      ) : null}
      {far ? (
        <span className="afd-node-title">{node.title}</span>
      ) : (
        <NodeBody node={node} near={near} />
      )}
      {selected && alone && !far && !dragging && isWork(node) ? <SummaryCard node={node} /> : null}
    </div>
  );
});

// Node on the canvas: a cheap shell with ports, plus a memoized body (07 §6). Below zoom 0.45 the
// body collapses to the title only (D-19 "far").
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
} from '@xyflow/react';
import { type MouseEvent, memo } from 'react';
import type { PortSide } from '../../core/flow/ports';
import type { FlowNode, NodeType } from '../../core/flow/types';
import { formatSeconds } from '../../core/run/view';
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

const NodeBody = memo(function NodeBody({ node }: { node: FlowNode }) {
  const implementation = useUi((s) => s.mode === 'implementation');
  const runMode = useUi((s) => s.mode === 'run');
  if (node.type === 'start' || node.type === 'end') {
    return <span className="afd-node-title">{node.title}</span>;
  }
  const status = node.status ?? 'draft';
  if (runMode)
    return (
      <>
        <div className="afd-node-head">
          <span className={`afd-dot status-${status}`} aria-hidden="true" />
          <span className="afd-node-title">{node.title}</span>
        </div>
        <RunLine node={node} />
      </>
    );
  if (implementation)
    return (
      <>
        <div className="afd-node-head">
          <span className={`afd-dot status-${status}`} aria-hidden="true" />
          <span className="afd-node-title">{node.title}</span>
        </div>
        <CodeLines node={node} />
      </>
    );
  const sub = [TYPE_LABEL[node.type], status, node.handler].filter(Boolean).join(' · ');
  return (
    <>
      <div className="afd-node-head">
        <span className={`afd-dot status-${status}`} aria-hidden="true" />
        <span className="afd-node-title">{node.title}</span>
      </div>
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

export const FlowNodeView = memo(function FlowNodeView({ data, selected }: NodeProps<FlowRFNode>) {
  const far = useStore(farSelector);
  const { node, ports } = data.view;
  // D-14: the node stays active while its port menu is open, so its ports do not vanish.
  const active = useUi((s) => s.portMenu?.ref.node === node.id);
  const runMode = useUi((s) => s.mode === 'run');
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
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <div className={classes} data-node-id={node.id} data-run-state={runState}>
      {/* Hover margin around the node and its port labels (D-14 detail). */}
      <div className="afd-hover-zone" aria-hidden="true" />
      {ports.map((p) => (
        <PortHandle key={p.name} nodeId={node.id} port={p} />
      ))}
      {far ? <span className="afd-node-title">{node.title}</span> : <NodeBody node={node} />}
    </div>
  );
});

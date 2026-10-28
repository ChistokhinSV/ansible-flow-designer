// Node on the canvas: a cheap shell with ports, plus a memoized body (07 §6). Below zoom 0.45 the
// body collapses to the title only (D-19 "far").
import {
  Handle,
  type Node,
  type NodeProps,
  Position,
  type ReactFlowState,
  useStore,
} from '@xyflow/react';
import { memo } from 'react';
import type { PortSide } from '../../core/flow/ports';
import type { FlowNode, NodeType } from '../../core/flow/types';
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

const STATE_LABEL: Record<PortState, string> = {
  connected: 'connected',
  'open-fail': 'open: not handled',
  'open-purpose': 'open on purpose',
  open: 'open',
};

const farSelector = (s: ReactFlowState) => s.transform[2] < 0.45;

function PortHandle({ port }: { port: PortView }) {
  const along = `${Math.round(port.offset * 100)}%`;
  const style = port.side === 'top' || port.side === 'bottom' ? { left: along } : { top: along };
  const isOutput = port.direction === 'out';
  return (
    <Handle
      id={port.name}
      type={isOutput ? 'source' : 'target'}
      position={SIDE[port.side]}
      // One edge per output port (03): a wired output cannot start another wire.
      isConnectableStart={isOutput && port.state !== 'connected'}
      isConnectableEnd={!isOutput}
      className={`afd-port state-${port.state} tone-${port.tone}${port.optional ? ' optional' : ''}`}
      style={style}
      data-port={port.name}
      title={`${port.name} · ${STATE_LABEL[port.state]}`}
      aria-label={`Port ${port.name}, ${STATE_LABEL[port.state]}`}
    />
  );
}

const NodeBody = memo(function NodeBody({ node }: { node: FlowNode }) {
  if (node.type === 'start' || node.type === 'end') {
    return <span className="afd-node-title">{node.title}</span>;
  }
  const status = node.status ?? 'draft';
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
  const classes = [
    'afd-node',
    `type-${node.type}`,
    `status-${node.status ?? 'draft'}`,
    node.handler ? 'handler' : '',
    node.type === 'end' && node.outcome === 'failed' ? 'outcome-failed' : '',
    selected ? 'selected' : '',
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <div className={classes} data-node-id={node.id}>
      {ports.map((p) => (
        <PortHandle key={p.name} port={p} />
      ))}
      {far ? <span className="afd-node-title">{node.title}</span> : <NodeBody node={node} />}
    </div>
  );
});

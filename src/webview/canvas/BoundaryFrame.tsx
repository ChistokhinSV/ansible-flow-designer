// The dashed boundary of an open subflow (D-23, mockup 10): the parent's ports sit on its edges,
// `in` on top as the source of the entry wire, outcomes below and problems on the right as the
// targets of the exit wires. The frame itself lets clicks and drags through to the canvas.
import { Handle, type Node, type NodeProps, Position } from '@xyflow/react';
import { memo } from 'react';
import type { BoundaryView, FramePortView } from '../viewModel';

export type FrameData = { boundary: BoundaryView; empty: boolean };
export type FrameRFNode = Node<FrameData, 'boundary'>;

// Frame ports sit on the frame's edges but face inward: the entry leaves `in` downwards and exits
// arrive from inside, so wires never loop around the frame. `position` sets the wire direction;
// the inline style puts the handle on its edge.
const FACING = { top: Position.Bottom, bottom: Position.Top, right: Position.Left } as const;
const ON_EDGE = {
  top: { top: 0, bottom: 'auto', transform: 'translate(-50%, -50%)' },
  bottom: { top: 'auto', bottom: 0, transform: 'translate(-50%, 50%)' },
  right: { left: 'auto', right: 0, transform: 'translate(50%, -50%)' },
} as const;

const STATE_TITLE: Record<FramePortView['state'], string> = {
  connected: 'an inner step leaves through it',
  bubbled: 'fed by inner fail ports that bubble up',
  unfed: 'no inner step leads here',
  available: 'optional; wiring an exit here enables it on the subflow',
};

function FramePort({ port }: { port: FramePortView }) {
  const along = `${port.offset * 100}%`;
  const style = {
    ...ON_EDGE[port.side],
    ...(port.side === 'right' ? { top: along } : { left: along }),
  };
  const title =
    port.name === 'in'
      ? port.state === 'connected'
        ? 'in: hosts entering the subflow start at the entry step'
        : 'in: no entry step yet; drag from here to an inner step'
      : `${port.name}: ${STATE_TITLE[port.state]}`;
  return (
    <Handle
      id={port.name}
      type={port.name === 'in' ? 'source' : 'target'}
      position={FACING[port.side]}
      style={style}
      className={`afd-frame-port state-${port.state} tone-${port.tone} side-${port.side}`}
      data-frame-port={port.name}
      data-port-state={port.state}
      title={title}
      aria-label={`Subflow port ${port.name}, ${STATE_TITLE[port.state] ?? port.state}`}
    >
      <span className="afd-frame-label">{port.name}</span>
    </Handle>
  );
}

function BoundaryFrameImpl({ data }: NodeProps<FrameRFNode>) {
  const { boundary, empty } = data;
  return (
    <div className="afd-frame" data-frame={boundary.subflow.id}>
      <span className="afd-frame-title">Subflow boundary · {boundary.subflow.title}</span>
      {empty ? <p className="afd-frame-empty">No steps yet.</p> : null}
      {boundary.ports.map((p) => (
        <FramePort key={p.name} port={p} />
      ))}
    </div>
  );
}

export const BoundaryFrame = memo(BoundaryFrameImpl);

// Changes lens (AFD-57): a node the compared version had and this one has not, drawn where it stood
// so a review sees what went. Not selectable, not wired, not counted by the canvas checks.
import type { Node, NodeProps } from '@xyflow/react';
import type { GhostNode } from '../../core/lens/types';
import { TYPE_LABEL } from '../constants';

export type GhostRFNode = Node<{ ghost: GhostNode }, 'ghost'>;

export function GhostNodeView({ data }: NodeProps<GhostRFNode>) {
  const { ghost } = data;
  return (
    <div className="afd-ghost" data-ghost={ghost.id} title={`Removed since the compared version`}>
      <div className="afd-ghost-title">{ghost.title}</div>
      <div className="afd-ghost-sub">{TYPE_LABEL[ghost.type]} · removed</div>
    </div>
  );
}

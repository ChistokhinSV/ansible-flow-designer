// Design-mode canvas. Nodes come from the snapshot; drags stay local until drop, then become one
// moveNodes command. Node objects are reused while their content is unchanged (07 §6).
// A click on a port opens its menu; dragging from it (beyond a few pixels) draws a wire.
import {
  applyNodeChanges,
  Background,
  BackgroundVariant,
  type Connection,
  Controls,
  type Edge,
  type EdgeChange,
  type FinalConnectionState,
  MarkerType,
  type NodeChange,
  ReactFlow,
  useReactFlow,
  type Viewport,
} from '@xyflow/react';
import { type DragEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { PATTERN_IDS, type PatternId } from '../../core/flow/patterns';
import type { NodeType, Position } from '../../core/flow/types';
import { command, loadState, saveState } from '../bus';
import { completePick, dropPattern } from '../portActions';
import { useUi } from '../store';
import { levelView, type NodeView } from '../viewModel';
import { FlowNodeView, type FlowRFNode, TYPE_LABEL } from './FlowNodeView';

const nodeTypes = { flow: FlowNodeView };
export const DRAG_MIME = 'application/x-afd-node-type';
export const PATTERN_MIME = 'application/x-afd-pattern';

interface SavedState {
  viewport?: Viewport;
}

function toRfNode(view: NodeView, selected: boolean): FlowRFNode {
  return {
    id: view.node.id,
    type: 'flow',
    position: view.position,
    width: view.width,
    height: view.height,
    data: { view },
    ariaLabel: `${TYPE_LABEL[view.node.type]} ${view.node.title}`,
    selected,
    deletable: true,
  };
}

/** `cull` skips off-screen nodes (07 §6); tests turn it off since jsdom has no layout. */
export function FlowCanvas({ cull = true }: { cull?: boolean }) {
  const snapshot = useUi((s) => s.snapshot);
  const optimistic = useUi((s) => s.optimistic);
  const selection = useUi((s) => s.selection);
  const select = useUi((s) => s.select);
  const setOptimistic = useUi((s) => s.setOptimistic);
  const openQuickAdd = useUi((s) => s.openQuickAdd);
  const setError = useUi((s) => s.setError);
  const picking = useUi((s) => s.pick !== null);
  const setPick = useUi((s) => s.setPick);
  const openPortMenu = useUi((s) => s.openPortMenu);
  const [connecting, setConnecting] = useState(false);
  const { screenToFlowPosition } = useReactFlow();

  const view = useMemo(
    () => (snapshot ? levelView(snapshot, optimistic) : { nodes: [], edges: [] }),
    [snapshot, optimistic],
  );

  // Structural sharing: keep the previous node object when its content did not change.
  const cache = useRef(new Map<string, { key: string; node: FlowRFNode }>());
  const derived = useMemo(() => {
    const next = new Map<string, { key: string; node: FlowRFNode }>();
    const nodes = view.nodes.map((v) => {
      const sel = selection.node === v.node.id;
      const key = JSON.stringify([v, sel]);
      const hit = cache.current.get(v.node.id);
      const entry = hit && hit.key === key ? hit : { key, node: toRfNode(v, sel) };
      next.set(v.node.id, entry);
      return entry.node;
    });
    cache.current = next;
    return nodes;
  }, [view.nodes, selection.node]);

  const [nodes, setNodes] = useState<FlowRFNode[]>(derived);
  useEffect(() => setNodes(derived), [derived]);

  const edges = useMemo<Edge[]>(
    () =>
      view.edges.map((e) => ({
        id: e.id,
        source: e.source,
        sourceHandle: e.sourcePort,
        target: e.target,
        targetHandle: e.targetPort,
        type: 'smoothstep',
        label: e.sourcePort,
        className: `afd-edge tone-${e.tone}${e.problem ? ' problem' : ''}`,
        markerEnd: {
          type: MarkerType.ArrowClosed,
          color: `var(--afd-${e.tone === 'neutral' ? 'neutral' : e.tone})`,
        },
        selected: selection.edge === e.id,
        deletable: true,
      })),
    [view.edges, selection.edge],
  );

  // Selection follows the user's select changes only. React Flow reports onSelectionChange one
  // commit late, so syncing from it fights a selection set from code (a node just created) and
  // loops; the select changes below are emitted for user actions only, never for prop updates.
  const onNodesChange = useCallback(
    (changes: NodeChange<FlowRFNode>[]) => {
      const picked = changes.filter((c) => c.type === 'select');
      if (picked.length > 0) {
        const on = picked.findLast((c) => c.selected);
        const current = useUi.getState().selection;
        if (on) {
          if (current.node !== on.id) select({ node: on.id });
        } else if (current.node && picked.some((c) => c.id === current.node)) {
          select({});
        }
      }
      setNodes((ns) =>
        applyNodeChanges(
          changes.filter((c) => c.type !== 'remove'),
          ns,
        ),
      );
    },
    [select],
  );

  const latest = useRef(nodes);
  latest.current = nodes;

  const onNodeDragStop = useCallback(
    (_e: unknown, _n: FlowRFNode, dragged: FlowRFNode[]) => {
      const positions: Record<string, Position> = {};
      const round = (p: Position) => ({ x: Math.round(p.x), y: Math.round(p.y) });
      for (const n of dragged) positions[n.id] = round(n.position);
      // Nodes still shown at in-memory auto positions are written too, so the first move freezes
      // the layout the user sees instead of letting the other nodes jump (ADR-0002).
      const stored = useUi.getState().snapshot?.doc?.layout ?? {};
      for (const n of latest.current)
        if (!stored[n.id] && !positions[n.id]) positions[n.id] = round(n.position);
      setOptimistic(positions);
      void command({ kind: 'moveNodes', positions }).then((ack) => {
        if (!ack.ok) setError(ack.error ?? 'Move failed');
      });
    },
    [setOptimistic, setError],
  );

  const onConnect = useCallback(
    (c: Connection) => {
      if (!c.sourceHandle || !c.targetHandle) return;
      void command({
        kind: 'connect',
        from: { node: c.source, port: c.sourceHandle },
        to: { node: c.target, port: c.targetHandle },
      }).then((ack) => {
        if (!ack.ok) setError(ack.error ?? 'Could not connect');
      });
    },
    [setError],
  );

  const onConnectEnd = useCallback(
    (event: MouseEvent | TouchEvent, state: FinalConnectionState) => {
      setConnecting(false);
      if (
        state.isValid ||
        !state.fromNode ||
        state.fromHandle?.type !== 'source' ||
        !state.fromHandle.id
      )
        return;
      const point = 'changedTouches' in event ? event.changedTouches[0] : event;
      if (!point) return;
      openQuickAdd({
        type: 'task',
        position: screenToFlowPosition({ x: point.clientX, y: point.clientY }),
        connectFrom: { node: state.fromNode.id, port: state.fromHandle.id },
      });
    },
    [openQuickAdd, screenToFlowPosition],
  );

  const onDelete = useCallback(
    ({ nodes: gone, edges: goneEdges }: { nodes: FlowRFNode[]; edges: Edge[] }) => {
      const ids = new Set(gone.map((n) => n.id));
      const run = async () => {
        for (const e of goneEdges) {
          if (ids.has(e.source) || ids.has(e.target)) continue;
          const ack = await command({ kind: 'disconnect', edge: e.id });
          if (!ack.ok) setError(ack.error ?? 'Could not remove the edge');
        }
        for (const id of ids) {
          const ack = await command({ kind: 'deleteNode', id });
          if (!ack.ok) setError(ack.error ?? 'Could not delete the node');
        }
      };
      void run();
    },
    [setError],
  );

  const onDrop = useCallback(
    (e: DragEvent) => {
      const pattern = e.dataTransfer.getData(PATTERN_MIME) as PatternId;
      if ((PATTERN_IDS as readonly string[]).includes(pattern)) {
        e.preventDefault();
        // D-16: dropped onto a port, or onto a node (its first open port the pattern fits).
        const hit = document.elementFromPoint(e.clientX, e.clientY);
        const port = hit?.closest<HTMLElement>('[data-port]')?.dataset.port;
        const node = hit?.closest<HTMLElement>('[data-node-id]')?.dataset.nodeId;
        if (node) void dropPattern(pattern, node, port);
        else setError('Drop a failure pattern onto an open fail port');
        return;
      }
      const type = e.dataTransfer.getData(DRAG_MIME) as NodeType;
      if (!type) return;
      e.preventDefault();
      openQuickAdd({ type, position: screenToFlowPosition({ x: e.clientX, y: e.clientY }) });
    },
    [openQuickAdd, screenToFlowPosition, setError],
  );

  const saved = useMemo(() => loadState<SavedState>(), []);

  return (
    <ReactFlow<FlowRFNode>
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      onNodesChange={onNodesChange}
      onEdgesChange={(changes: EdgeChange[]) => {
        const picked = changes.filter((c) => c.type === 'select');
        const on = picked.findLast((c) => c.selected);
        const current = useUi.getState().selection;
        if (on) {
          if (current.edge !== on.id) select({ edge: on.id });
        } else if (current.edge && picked.some((c) => c.id === current.edge)) {
          select({});
        }
      }}
      onNodeDragStop={onNodeDragStop}
      onConnect={onConnect}
      onConnectStart={() => setConnecting(true)}
      onConnectEnd={onConnectEnd}
      connectOnClick={false}
      connectionDragThreshold={4}
      onNodeClick={(_e, n) => {
        if (picking) void completePick(n.id);
      }}
      onPaneClick={() => {
        if (picking) setPick(null);
      }}
      onMoveStart={() => openPortMenu(null)}
      className={[connecting ? 'afd-connecting' : '', picking ? 'afd-picking' : '']
        .filter(Boolean)
        .join(' ')}
      onDelete={onDelete}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes(DRAG_MIME) || e.dataTransfer.types.includes(PATTERN_MIME))
          e.preventDefault();
      }}
      onDrop={onDrop}
      onMoveEnd={(_e, viewport) => saveState<SavedState>({ ...loadState<SavedState>(), viewport })}
      isValidConnection={(c) => c.source !== c.target}
      deleteKeyCode={['Delete', 'Backspace']}
      onlyRenderVisibleElements={cull}
      defaultViewport={saved.viewport}
      fitView={!saved.viewport}
      fitViewOptions={{ padding: 0.15, maxZoom: 1.1 }}
      minZoom={0.2}
      maxZoom={2}
      proOptions={{ hideAttribution: true }}
    >
      <Background variant={BackgroundVariant.Dots} gap={16} size={1} />
      <Controls showInteractive={false} position="bottom-right" />
    </ReactFlow>
  );
}

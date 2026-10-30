// Design-mode canvas. Nodes come from the snapshot; drags stay local until drop, then become one
// moveNodes command. Node objects are reused while their content is unchanged (07 §6).
// A click on a port opens its menu; dragging from it (beyond a few pixels) draws a wire.
// Inside a subflow (M4, D-23) the level's nodes sit in a boundary frame whose ports carry the entry
// and exit wires; wiring to the frame edits `subflow.boundary`. Double-click or Enter opens a subflow.
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
import { ROOT } from '../../core/flow/model';
import { PATTERN_IDS, type PatternId } from '../../core/flow/patterns';
import type { NodeType, Position } from '../../core/flow/types';
import type { RunSummary } from '../../core/run/events';
import { wireHosts } from '../../core/run/view';
import { command, loadState, saveState } from '../bus';
import { completePick, dropPattern } from '../portActions';
import { hasPreview } from '../preview';
import { useUi } from '../store';
import { type BoundaryEdgeView, boundaryView, levelView, type NodeView } from '../viewModel';
import { BoundaryFrame, type FrameRFNode } from './BoundaryFrame';
import { FlowNodeView, type FlowRFNode, TYPE_LABEL } from './FlowNodeView';

const nodeTypes = { flow: FlowNodeView, boundary: BoundaryFrame };
type CanvasNode = FlowRFNode | FrameRFNode;
export const DRAG_MIME = 'application/x-afd-node-type';
export const PATTERN_MIME = 'application/x-afd-pattern';

interface SavedState {
  /** Top-level viewport (M1–M3 state). */
  viewport?: Viewport;
  /** Viewport per level (M4). */
  viewports?: Record<string, Viewport>;
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
const hostCount = (n: number) => `${n} host${n === 1 ? '' : 's'}`;

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
  const level = useUi((s) => s.level);
  const setLevel = useUi((s) => s.setLevel);
  const [connecting, setConnecting] = useState(false);
  const { screenToFlowPosition } = useReactFlow();
  // Run mode (04 §10): wires show how many hosts took them; the graph is read-only there.
  const runMode = useUi((s) => s.mode === 'run');
  const ran = useUi((s) => (s.mode === 'run' ? s.run?.summary : undefined));
  // Lenses (M8): Inventory labels wires with last-run host counts, Data adds derived data wires.
  const lensWires = useUi((s) => s.lensView?.wires);
  const dataWires = useUi((s) => s.lensView?.dataWires);
  const dataLens = useUi((s) => s.lens === 'data');

  const view = useMemo(
    () => (snapshot ? levelView(snapshot, optimistic, level) : { nodes: [], edges: [] }),
    [snapshot, optimistic, level],
  );
  const boundary = useMemo(
    () => (snapshot ? boundaryView(snapshot, view, level) : undefined),
    [snapshot, view, level],
  );
  const frameKey = boundary
    ? JSON.stringify([boundary.frame, boundary.ports, view.nodes.length])
    : '';
  // biome-ignore lint/correctness/useExhaustiveDependencies: the frame object changes only with frameKey
  const frame = useMemo<FrameRFNode | undefined>(
    () =>
      boundary
        ? {
            id: boundary.id,
            type: 'boundary',
            position: { x: boundary.frame.x, y: boundary.frame.y },
            width: boundary.frame.width,
            height: boundary.frame.height,
            data: { boundary, empty: view.nodes.length === 0 },
            draggable: false,
            selectable: false,
            deletable: false,
            focusable: false,
            zIndex: -1,
            style: { pointerEvents: 'none' },
          }
        : undefined,
    [frameKey],
  );

  // Structural sharing: keep the previous node object when its content did not change.
  const cache = useRef(new Map<string, { key: string; node: FlowRFNode }>());
  const derived = useMemo(() => {
    const next = new Map<string, { key: string; node: FlowRFNode }>();
    const nodes = view.nodes.map((v) => {
      const sel = selection.node === v.node.id || !!selection.nodes?.includes(v.node.id);
      const key = JSON.stringify([v, sel]);
      const hit = cache.current.get(v.node.id);
      const entry = hit && hit.key === key ? hit : { key, node: toRfNode(v, sel) };
      next.set(v.node.id, entry);
      return entry.node;
    });
    cache.current = next;
    return frame ? [frame, ...nodes] : nodes;
  }, [view.nodes, selection.node, selection.nodes, frame]);

  const [nodes, setNodes] = useState<CanvasNode[]>(derived);
  useEffect(() => setNodes(derived), [derived]);
  const latest = useRef(nodes);
  latest.current = nodes;
  const exits = useMemo(() => new Map((boundary?.edges ?? []).map((e) => [e.id, e])), [boundary]);

  // A start node has no play: its wire carries every host of the run.
  const hostsOn = useMemo(() => {
    const starts = new Set(view.nodes.filter((v) => v.node.type === 'start').map((v) => v.node.id));
    return (s: RunSummary, e: { source: string; sourcePort: string }) =>
      starts.has(e.source) ? s.hosts : wireHosts(s, e.source, e.sourcePort);
  }, [view.nodes]);
  const edges = useMemo<Edge[]>(
    () =>
      view.edges.map((e) => ({
        id: e.id,
        source: e.source,
        sourceHandle: e.sourcePort,
        target: e.target,
        targetHandle: e.targetPort,
        type: 'smoothstep',
        label: ran ? hostCount(hostsOn(ran, e).length) : (lensWires?.[e.id] ?? e.sourcePort),
        className: `afd-edge tone-${e.tone}${e.problem ? ' problem' : ''}${
          ran ? (hostsOn(ran, e).length > 0 ? ' run-taken' : ' run-idle') : ''
        }${dataLens ? ' lens-control' : ''}`,
        markerEnd: {
          type: MarkerType.ArrowClosed,
          color: `var(--afd-${e.tone === 'neutral' ? 'neutral' : e.tone})`,
        },
        selected: selection.edge === e.id,
        deletable: !runMode,
      })),
    [view.edges, selection.edge, ran, runMode, hostsOn, lensWires, dataLens],
  );
  const dataEdges = useMemo<Edge[]>(() => {
    if (!dataLens || !dataWires) return [];
    const here = new Set(view.nodes.map((v) => v.node.id));
    return dataWires
      .filter((w) => here.has(w.from) && here.has(w.to))
      .map((w) => ({
        id: w.id,
        source: w.from,
        sourceHandle: '__data_out',
        target: w.to,
        targetHandle: '__data_in',
        type: 'default',
        label: w.label,
        className: 'afd-edge afd-data-edge',
        data: { title: w.title },
        markerEnd: { type: MarkerType.ArrowClosed, color: 'var(--afd-lens-data)' },
        selectable: false,
        deletable: false,
        focusable: false,
      }));
  }, [dataLens, dataWires, view.nodes]);
  const allEdges = useMemo<Edge[]>(
    () => [
      ...edges,
      ...dataEdges,
      ...(boundary?.edges ?? []).map((e: BoundaryEdgeView) => ({
        id: e.id,
        source: e.source,
        sourceHandle: e.sourcePort,
        target: e.target,
        targetHandle: e.targetPort,
        type: 'smoothstep',
        label: e.label,
        className: `afd-edge afd-boundary-edge tone-${e.tone}${e.problem ? ' problem' : ''}`,
        markerEnd: {
          type: MarkerType.ArrowClosed,
          color: `var(--afd-${e.tone === 'neutral' ? 'neutral' : e.tone})`,
        },
        selected: selection.edge === e.id,
        deletable: true,
      })),
    ],
    [edges, dataEdges, boundary, selection.edge],
  );

  // Selection follows the user's select changes only. React Flow reports onSelectionChange one
  // commit late, so syncing from it fights a selection set from code (a node just created) and
  // loops; the select changes below are emitted for user actions only, never for prop updates.
  const onNodesChange = useCallback(
    (changes: NodeChange<CanvasNode>[]) => {
      const picked = changes.filter((c) => c.type === 'select');
      if (picked.length > 0) {
        // Several nodes (Ctrl/Cmd+click, Shift+drag) select as a group (AFD-7).
        const chosen = applyNodeChanges(picked, latest.current)
          .filter((n) => n.type === 'flow' && n.selected)
          .map((n) => n.id);
        const current = useUi.getState().selection;
        if (chosen.length > 1) select({ nodes: chosen });
        else if (chosen.length === 1) {
          if (current.node !== chosen[0]) select({ node: chosen[0] });
        } else if (current.node || current.nodes) select({});
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

  const onNodeDragStop = useCallback(
    (_e: unknown, _n: CanvasNode, dragged: CanvasNode[]) => {
      const positions: Record<string, Position> = {};
      const round = (p: Position) => ({ x: Math.round(p.x), y: Math.round(p.y) });
      for (const n of dragged) positions[n.id] = round(n.position);
      // Nodes still shown at in-memory auto positions are written too, so the first move freezes
      // the layout the user sees instead of letting the other nodes jump (ADR-0002).
      const stored = useUi.getState().snapshot?.doc?.layout ?? {};
      for (const n of latest.current)
        if (n.type === 'flow' && !stored[n.id] && !positions[n.id])
          positions[n.id] = round(n.position);
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
      const subflow = boundary?.subflow.id;
      // Wires from the frame's `in` set the entry; wires into a frame port are exits (D-23).
      if (subflow && c.source === boundary.id) {
        void command({ kind: 'setBoundaryIn', subflow, node: c.target }).then((ack) => {
          if (!ack.ok) setError(ack.error ?? 'Could not set the entry');
        });
        return;
      }
      if (subflow && c.target === boundary.id) {
        void command({
          kind: 'connectBoundary',
          subflow,
          from: { node: c.source, port: c.sourceHandle },
          port: c.targetHandle,
        }).then((ack) => {
          if (!ack.ok) setError(ack.error ?? 'Could not add the exit');
        });
        return;
      }
      void command({
        kind: 'connect',
        from: { node: c.source, port: c.sourceHandle },
        to: { node: c.target, port: c.targetHandle },
      }).then((ack) => {
        if (!ack.ok) setError(ack.error ?? 'Could not connect');
      });
    },
    [setError, boundary],
  );

  const onConnectEnd = useCallback(
    (event: MouseEvent | TouchEvent, state: FinalConnectionState) => {
      setConnecting(false);
      if (
        state.isValid ||
        !state.fromNode ||
        state.fromNode.type !== 'flow' ||
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
    ({ nodes: gone, edges: goneEdges }: { nodes: CanvasNode[]; edges: Edge[] }) => {
      const ids = new Set(gone.filter((n) => n.type === 'flow').map((n) => n.id));
      const run = async () => {
        for (const e of goneEdges) {
          if (ids.has(e.source) || ids.has(e.target)) continue;
          const b = exits.get(e.id);
          const subflow = boundary?.subflow.id;
          const ack =
            b && subflow
              ? b.exit
                ? await command({ kind: 'disconnectBoundary', subflow, ...b.exit })
                : await command({ kind: 'setBoundaryIn', subflow, node: null })
              : await command({ kind: 'disconnect', edge: e.id });
          if (!ack.ok) setError(ack.error ?? 'Could not remove the edge');
        }
        for (const id of ids) {
          const ack = await command({ kind: 'deleteNode', id });
          if (!ack.ok) setError(ack.error ?? 'Could not delete the node');
        }
      };
      void run();
    },
    [setError, exits, boundary],
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
  const savedViewport = saved.viewports?.[level] ?? (level === ROOT ? saved.viewport : undefined);

  // Enter on a selected subflow opens it (04 §8), unless a field has the focus.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Enter' || e.defaultPrevented) return;
      const t = e.target as HTMLElement | null;
      if (t?.closest('input, textarea, select, button, [role="menu"], [role="dialog"]')) return;
      const { selection: sel, snapshot: snap } = useUi.getState();
      const n = view.nodes.find((v) => v.node.id === sel.node)?.node;
      if (n?.type === 'subflow' && snap) setLevel(n.id);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [view.nodes, setLevel]);

  return (
    <ReactFlow<CanvasNode>
      nodes={nodes}
      edges={allEdges}
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
      onConnectStart={() => {
        setConnecting(true);
        useUi.getState().setPreview(null);
      }}
      onConnectEnd={onConnectEnd}
      connectOnClick={false}
      connectionDragThreshold={4}
      onNodeClick={(_e, n) => {
        if (picking && n.type === 'flow') void completePick(n.id);
      }}
      onNodeMouseEnter={(e, n) => {
        if (n.type !== 'flow' || !hasPreview(n.data.view.node)) return;
        const r = (e.currentTarget as Element).getBoundingClientRect();
        useUi.getState().hoverNode(n.id, { left: r.left, right: r.right, top: r.top });
      }}
      onNodeMouseLeave={() => useUi.getState().hoverNode(null)}
      onNodeDragStart={() => useUi.getState().setPreview(null)}
      onNodeDoubleClick={(_e, n) => {
        if (n.type === 'flow' && n.data.view.node.type === 'subflow') setLevel(n.id);
      }}
      zoomOnDoubleClick={false}
      onPaneClick={() => {
        if (picking) setPick(null);
      }}
      onMoveStart={() => {
        openPortMenu(null);
        useUi.getState().setPreview(null);
      }}
      className={[connecting ? 'afd-connecting' : '', picking ? 'afd-picking' : '']
        .filter(Boolean)
        .join(' ')}
      onDelete={onDelete}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes(DRAG_MIME) || e.dataTransfer.types.includes(PATTERN_MIME))
          e.preventDefault();
      }}
      onDrop={onDrop}
      onMoveEnd={(_e, viewport) => {
        const state = loadState<SavedState>();
        saveState<SavedState>({ ...state, viewports: { ...state.viewports, [level]: viewport } });
      }}
      isValidConnection={(c) => c.source !== c.target}
      nodesConnectable={!runMode}
      deleteKeyCode={runMode ? null : ['Delete', 'Backspace']}
      onlyRenderVisibleElements={cull}
      defaultViewport={savedViewport}
      fitView={!savedViewport}
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

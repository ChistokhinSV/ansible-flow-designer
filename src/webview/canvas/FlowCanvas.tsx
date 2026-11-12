// Design-mode canvas. Nodes come from the snapshot; drags stay local until drop, then become one
// moveNodes command. Node objects are reused while their content is unchanged (07 §6).
// A click on a port opens its menu; dragging from it (beyond a few pixels) draws a wire.
// Inside a subflow (M4, D-23) the level's nodes sit in a boundary frame whose ports carry the entry
// and exit wires; wiring to the frame edits `subflow.boundary`. Double-click or Enter opens a subflow.
// AFD-65: Notes, Sections and Text are nodes without ports, layered by hand (zIndexMode manual):
// Sections behind everything, a Note on a node as that node's child, in front of it.
// AFD-70: wires step round the nodes in their way (RoutedEdge), as in the exports.
import {
  applyNodeChanges,
  Background,
  BackgroundVariant,
  type Connection,
  ControlButton,
  Controls,
  type Edge,
  type EdgeChange,
  type FinalConnectionState,
  getNodesBounds,
  MarkerType,
  MiniMap,
  type NodeChange,
  Panel,
  ReactFlow,
  useReactFlow,
  useStore,
  type Viewport,
  ViewportPortal,
} from '@xyflow/react';
import {
  type DragEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { type AnnotationView, sectionContents } from '../../core/flow/annotations';
import { type Box as ArrangeBox, type Guides, guides as guidesFor } from '../../core/flow/arrange';
import type { CanvasTarget } from '../../core/flow/canvasMenu';
import { spliceProblem } from '../../core/flow/heal';
import { ROOT } from '../../core/flow/model';
import { PATTERN_IDS, type PatternId } from '../../core/flow/patterns';
import { sharedAround } from '../../core/flow/refs';
import type { AnnotationKind, NodeType, Position } from '../../core/flow/types';
import type { GhostNode } from '../../core/lens/types';
import type { RunSummary } from '../../core/run/events';
import { wireHosts } from '../../core/run/view';
import { belowNodes, FULL_FIT, minimapCorner, readableViewport, union } from '../../core/view/fit';
import { exitLabelledAtRest, labelledAtRest } from '../../core/view/nodeFace';
import { pickCandidates, stepPick } from '../../core/view/pick';
import type { Box } from '../../core/view/route';
import { addAnnotation, editAnnotation } from '../annotationActions';
import { command, loadState, saveState } from '../bus';
import { setPastePlace } from '../clipboard';
import { ANNOTATION_MIME, DRAG_MIME, PATTERN_MIME, TYPE_LABEL } from '../constants';
import { boundaryWire, upLevel } from '../editActions';
import { useLevelView, useModel } from '../hooks';
import { EmptyLevel, useEmptyLevel } from '../panels/EmptyLevel';
import { FindBar } from '../panels/FindBar';
import { FirstFlow, useFirstFlowShown } from '../panels/FirstFlow';
import { INSERTABLE } from '../panels/QuickAdd';
import { completePick, dropPattern, dropWireEnd } from '../portActions';
import { hasPreview } from '../preview';
import { useUi } from '../store';
import { type BoundaryEdgeView, boundaryView, type NodeView } from '../viewModel';
import { AnnotationNodeView, type AnnotationRFNode, annotationName } from './AnnotationNode';
import { BoundaryFrame, type FrameRFNode } from './BoundaryFrame';
import { FlowNodeView, type FlowRFNode } from './FlowNodeView';
import { GhostNodeView, type GhostRFNode } from './GhostNode';
import { NodeBoxes, RoutedEdge, WireHover } from './RoutedEdge';

const nodeTypes = {
  flow: FlowNodeView,
  boundary: BoundaryFrame,
  ghost: GhostNodeView,
  annotation: AnnotationNodeView,
};
type CanvasNode = FlowRFNode | FrameRFNode | GhostRFNode | AnnotationRFNode;
const edgeTypes = { routed: RoutedEdge };

const NO_NOTES: AnnotationView[] = [];
const NO_RECONNECT = () => {};

/** The minimap draws Sections as outlines, Notes as small fills and Text not at all. */
const miniKind = (n: { type?: string; data: unknown }) =>
  n.type === 'annotation' ? (n.data as AnnotationRFNode['data']).view.kind : undefined;

/** Layers (zIndexMode manual): Sections, the subflow frame, wires and Notes, nodes, tied Notes. */
const Z = { section: -2, frame: -1, note: 0, node: 1, tied: 2 } as const;

/**
 * A Note, Section or Text as a canvas node. A Note on a node shown here is that node's child: its
 * position is relative, as stored, so it follows the node wherever it goes.
 */
export function toAnnotationNode(
  v: AnnotationView,
  selected: boolean,
  editable: boolean,
  shown: ReadonlySet<string>,
  optimistic: Record<string, Position>,
  mark?: 'added' | 'changed',
): AnnotationRFNode {
  const a = v.annotation;
  const tied = v.on && shown.has(v.on) ? v.on : undefined;
  return {
    id: a.id,
    type: 'annotation',
    position: tied ? (optimistic[a.id] ?? { x: a.x, y: a.y }) : v.position,
    ...(tied ? { parentId: tied } : {}),
    width: v.width,
    height: v.height,
    // AFD-68: React Flow's resizer starts from `measured`, which a new node object lacks until it
    // is measured again (the DOM size does not change, so that can wait); a resize then began at
    // 0 and collapsed. The size is ours, so say it.
    measured: { width: v.width, height: v.height },
    data: { view: v, editable },
    selected,
    zIndex: v.kind === 'section' ? Z.section : tied ? Z.tied : Z.note,
    ...(v.kind === 'section'
      ? { dragHandle: '.afd-annotation-title', style: { pointerEvents: 'none' as const } }
      : {}),
    ariaLabel: annotationName(v),
    // The Changes lens outlines what was added or changed (AFD-66).
    ...(mark ? { className: `afd-mark-${mark}` } : {}),
    draggable: editable,
    deletable: false,
    connectable: false,
  };
}

interface SavedState {
  /** Top-level viewport (M1–M3 state). */
  viewport?: Viewport;
  /** Viewport per level (M4). */
  viewports?: Record<string, Viewport>;
}

/** What a screen reader says for a node (AFD-47): type, title, status and open fail ports. */
function nodeName({ node, ports }: NodeView): string {
  const status = node.type === 'start' || node.type === 'end' ? '' : `, ${node.status ?? 'draft'}`;
  const open = ports.filter((p) => p.state === 'open-fail').length;
  const ports_ = open ? `, ${open} open fail port${open === 1 ? '' : 's'}` : '';
  return `${TYPE_LABEL[node.type]} ${node.title}${status}${ports_}`;
}

/**
 * Ghosts where the compared version stored them; one without a stored place goes in a column to the
 * right of the level, so it never covers a node.
 */
function ghostNodes(ghosts: GhostNode[], nodes: NodeView[]): GhostRFNode[] {
  const right = Math.max(0, ...nodes.map((n) => n.position.x + n.width)) + 80;
  const top = Math.min(...nodes.map((n) => n.position.y), 0);
  let row = 0;
  return ghosts.map((g) => ({
    id: `ghost:${g.id}`,
    type: 'ghost',
    position: g.position ?? { x: right, y: top + 90 * row++ },
    data: { ghost: g },
    selectable: false,
    draggable: false,
    connectable: false,
    deletable: false,
    focusable: false,
  }));
}

function toRfNode(view: NodeView, selected: boolean): FlowRFNode {
  return {
    id: view.node.id,
    type: 'flow',
    position: view.position,
    width: view.width,
    height: view.height,
    data: { view },
    ariaLabel: nodeName(view),
    selected,
    deletable: true,
    zIndex: Z.node,
  };
}

/**
 * `cull` skips off-screen nodes (07 §6); tests turn it off since jsdom has no layout. In test mode
 * (VS Code's integration tests, the harness) every node is drawn: levels now open at a readable
 * zoom with part of a large level off screen (AFD-42), and the checks read every node and port.
 */
const hostCount = (n: number) => `${n} host${n === 1 ? '' : 's'}`;

export function FlowCanvas({ cull = true }: { cull?: boolean }) {
  const snapshot = useUi((s) => s.snapshot);
  const _optimistic = useUi((s) => s.optimistic);
  const selection = useUi((s) => s.selection);
  const select = useUi((s) => s.select);
  const setOptimistic = useUi((s) => s.setOptimistic);
  const openQuickAdd = useUi((s) => s.openQuickAdd);
  const setError = useUi((s) => s.setError);
  const picking = useUi((s) => s.pick !== null);
  const setPick = useUi((s) => s.setPick);
  const openPortMenu = useUi((s) => s.openPortMenu);
  const openContextMenu = useUi((s) => s.openContextMenu);
  const level = useUi((s) => s.level);
  const setLevel = useUi((s) => s.setLevel);
  const [connecting, setConnecting] = useState(false);
  // AFD-233: the end of a wire being dragged to another port ('source': its start).
  const [reconnecting, setReconnecting] = useState<'source' | 'target' | null>(null);
  const reconnect = useRef(false);
  const testMode = useUi((s) => s.testMode);
  const [hoverEdge, setHoverEdge] = useState<string | null>(null);
  // AFD-231: the hover outlives the pointer's trip from the wire to its +.
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const hoverWire = useCallback((id: string | null) => {
    clearTimeout(hoverTimer.current);
    if (id) setHoverEdge(id);
    else hoverTimer.current = setTimeout(() => setHoverEdge(null), 250);
  }, []);
  useEffect(() => () => clearTimeout(hoverTimer.current), []);
  // The wire under a palette step being dragged: it lights, and the drop inserts the step there.
  const dropWire = useRef<string | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const shows = useCallback(
    (id: string, port: string) => labelledAtRest(port) || id === hoverEdge || id === selection.edge,
    [hoverEdge, selection.edge],
  );
  const { screenToFlowPosition, setViewport, fitView, getViewport, setCenter } = useReactFlow();
  const centerOn = useUi((s) => s.centerOn);
  const model = useModel();
  const pickAt = useUi((s) => (s.pick ? s.pickAt : null));
  const paneWidth = useStore((s) => s.width);
  const paneHeight = useStore((s) => s.height);
  // Run mode (04 §10): wires show how many hosts took them; the graph is read-only there.
  // Code and Run modes show the graph read-only (AFD-45); Run mode also labels wires with hosts.
  // A shared subflow's level (AFD-60) is edited in its source flow.
  const readOnly = useUi(
    (s) => s.mode !== 'design' || (!!s.snapshot?.doc && !!sharedAround(s.snapshot.doc, s.level)),
  );
  // Written by hand without IDs (AFD-19): shown, not edited, until Complete IDs.
  const handWritten = useUi((s) => !!s.snapshot?.idGaps);
  const ran = useUi((s) => (s.mode === 'run' ? s.run?.summary : undefined));
  // Under a lens or in Run mode the flow speaks; annotations step back (AFD-65).
  const dimNotes = useUi((s) => s.lens !== null || s.mode === 'run');
  // Lenses (M8): Inventory labels wires with last-run host counts, Data adds derived data wires.
  const lensWires = useUi((s) => s.lensView?.wires);
  const dataWires = useUi((s) => s.lensView?.dataWires);
  const dataLens = useUi((s) => s.lens === 'data');
  // Changes lens (AFD-57): nodes the compared version had on this level, drawn as ghosts.
  const allGhosts = useUi((s) => (s.lens === 'changes' ? s.lensView?.ghosts : undefined));
  const ghosts = useMemo(
    () => (allGhosts ?? []).filter((g) => g.level === level),
    [allGhosts, level],
  );

  const view = useLevelView();
  // AFD-65: annotations, unless this viewer hid them; edited in Design mode only.
  const hidden = useUi((s) => s.annotationsHidden);
  const optimistic = useUi((s) => s.optimistic);
  const editable = !readOnly && !handWritten;
  const marks = useUi((s) => (s.lens === 'changes' ? s.lensView?.annotations : undefined));
  // A stable empty list: a new one per render would rebuild the nodes, and render again.
  const notes = hidden ? NO_NOTES : view.annotations;
  // AFD-42: the minimap shows while part of the level is out of view.
  const contentBounds = useMemo(() => {
    const boxes = [
      ...view.nodes.map((v) => toRfNode(v, false)),
      ...notes.map((a) => ({ position: a.position, width: a.width, height: a.height })),
    ];
    return boxes.length ? getNodesBounds(boxes as never) : null;
  }, [view.nodes, notes]);
  // A level with only Start and End shows how to begin, under them (AFD-48).
  const empty = useEmptyLevel();
  const cardAt = useMemo(
    () => (empty ? belowNodes(contentBounds ?? { x: 0, y: 0, width: 0, height: 0 }) : null),
    [empty, contentBounds],
  );
  // AFD-72: the minimap never covers a node; when both left corners would, a button shows it.
  const checklist = useFirstFlowShown();
  const corner = useStore((s) => {
    const [x, y, zoom] = s.transform;
    const boxes = view.nodes.map((n) => ({
      x: n.position.x * zoom + x,
      y: n.position.y * zoom + y,
      width: n.width * zoom,
      height: n.height * zoom,
    }));
    return minimapCorner(boxes, { width: s.width, height: s.height }, checklist);
  });
  const [miniAsked, setMiniAsked] = useState(false);
  const partly = useStore((s) => {
    if (!contentBounds || s.width <= 0) return false;
    const [x, y, zoom] = s.transform;
    const left = contentBounds.x * zoom + x;
    const top = contentBounds.y * zoom + y;
    return (
      left < 0 ||
      top < 0 ||
      left + contentBounds.width * zoom > s.width ||
      top + contentBounds.height * zoom > s.height
    );
  });
  const boundary = useMemo(
    () => (snapshot ? boundaryView(snapshot, view, level) : undefined),
    [snapshot, view, level],
  );
  const frameKey = boundary
    ? JSON.stringify([boundary.frame, boundary.ports, view.nodes.length, empty])
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
            // AFD-71: the empty-level card says how to begin; the frame only when it is not shown.
            data: { boundary, empty: view.nodes.length === 0 && !empty },
            draggable: false,
            selectable: false,
            deletable: false,
            focusable: false,
            zIndex: Z.frame,
            style: { pointerEvents: 'none' },
          }
        : undefined,
    [frameKey],
  );

  // Structural sharing: keep the previous node object when its content did not change.
  const cache = useRef(new Map<string, { key: string; node: FlowRFNode }>());
  const annotationCache = useRef(new Map<string, { key: string; node: AnnotationRFNode }>());
  const derived = useMemo(() => {
    const next = new Map<string, { key: string; node: FlowRFNode }>();
    const nextNotes = new Map<string, { key: string; node: AnnotationRFNode }>();
    const nodes = view.nodes.map((v) => {
      const sel = selection.node === v.node.id || !!selection.nodes?.includes(v.node.id);
      const key = JSON.stringify([v, sel]);
      const hit = cache.current.get(v.node.id);
      const entry = hit && hit.key === key ? hit : { key, node: toRfNode(v, sel) };
      next.set(v.node.id, entry);
      return entry.node;
    });
    cache.current = next;
    // Annotations after the nodes: a child follows its parent, and Tab reaches the steps first.
    const shownIds = new Set(view.nodes.map((v) => v.node.id));
    const picked = new Set(selection.annotations ?? []);
    const annotated = notes.map((v) => {
      const sel = picked.has(v.annotation.id);
      const mark = marks?.[v.annotation.id];
      const key = JSON.stringify([v, sel, editable, optimistic[v.annotation.id], mark]);
      const hit = annotationCache.current.get(v.annotation.id);
      const entry =
        hit && hit.key === key
          ? hit
          : { key, node: toAnnotationNode(v, sel, editable, shownIds, optimistic, mark) };
      nextNotes.set(v.annotation.id, entry);
      return entry.node;
    });
    annotationCache.current = nextNotes;
    const all: CanvasNode[] = frame ? [frame, ...nodes, ...annotated] : [...nodes, ...annotated];
    return ghosts.length > 0 ? [...all, ...ghostNodes(ghosts, view.nodes)] : all;
  }, [
    view.nodes,
    selection.node,
    selection.nodes,
    selection.annotations,
    frame,
    ghosts,
    notes,
    editable,
    optimistic,
    marks,
  ]);

  const [nodes, setNodes] = useState<CanvasNode[]>(derived);
  useEffect(() => setNodes(derived), [derived]);
  const latest = useRef(nodes);
  latest.current = nodes;
  // Where the steps are drawn now (a drag included): what wires step round. Notes, Sections, the
  // frame and ghosts are not in the way.
  const flowNodes = nodes.filter((n) => n.type === 'flow');
  const boxKey = flowNodes
    .map((n) => `${n.position.x},${n.position.y},${n.width},${n.height}`)
    .join(';');
  // biome-ignore lint/correctness/useExhaustiveDependencies: the boxes change only with boxKey
  const boxes = useMemo<Box[]>(
    () =>
      flowNodes.map((n) => ({
        x: n.position.x,
        y: n.position.y,
        width: n.width ?? 0,
        height: n.height ?? 0,
      })),
    [boxKey],
  );

  // AFD-85: wires added outside the designer.
  const outsideEdges = useUi((s) => s.outside?.edges);
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
        type: 'routed',
        label: ran
          ? hostCount(hostsOn(ran, e).length)
          : (lensWires?.[e.id] ?? (shows(e.id, e.sourcePort) ? e.sourcePort : undefined)),
        className: `afd-edge tone-${e.tone}${e.problem ? ' problem' : ''}${
          ran ? (hostsOn(ran, e).length > 0 ? ' run-taken' : ' run-idle') : ''
        }${dataLens ? ' lens-control' : ''}${outsideEdges?.includes(e.id) ? ' outside-mark' : ''}${
          dropTarget === e.id ? ' drop-target' : ''
        }`,
        markerEnd: {
          type: MarkerType.ArrowClosed,
          color: `var(--afd-${e.tone === 'neutral' ? 'neutral' : e.tone})`,
        },
        selected: selection.edge === e.id,
        deletable: !readOnly,
        reconnectable: editable,
        data: { plus: editable && (hoverEdge === e.id || selection.edge === e.id) },
      })),
    [
      view.edges,
      selection.edge,
      ran,
      readOnly,
      editable,
      hoverEdge,
      hostsOn,
      lensWires,
      dataLens,
      shows,
      outsideEdges,
      dropTarget,
    ],
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
        reconnectable: false,
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
        type: 'routed',
        label: exitLabelledAtRest(e) || shows(e.id, 'in') ? e.label : undefined,
        className: `afd-edge afd-boundary-edge tone-${e.tone}${e.problem ? ' problem' : ''}`,
        markerEnd: {
          type: MarkerType.ArrowClosed,
          color: `var(--afd-${e.tone === 'neutral' ? 'neutral' : e.tone})`,
        },
        selected: selection.edge === e.id,
        deletable: true,
        reconnectable: false,
      })),
    ],
    [edges, dataEdges, boundary, selection.edge, shows],
  );

  // Selection follows the user's select changes only. React Flow reports onSelectionChange one
  // commit late, so syncing from it fights a selection set from code (a node just created) and
  // loops; the select changes below are emitted for user actions only, never for prop updates.
  const onNodesChange = useCallback(
    (changes: NodeChange<CanvasNode>[]) => {
      const picked = changes.filter((c) => c.type === 'select');
      if (picked.length > 0) {
        // Several nodes (Ctrl/Cmd+click, Shift+drag) select as a group (AFD-7); annotations
        // picked with them come along (AFD-65).
        const after = applyNodeChanges(picked, latest.current).filter((n) => n.selected);
        const chosen = after.filter((n) => n.type === 'flow').map((n) => n.id);
        const notes = after.filter((n) => n.type === 'annotation').map((n) => n.id);
        const current = useUi.getState().selection;
        const also = notes.length ? { annotations: notes } : {};
        const same = (a: string[] | undefined, b: string[]) =>
          (a ?? []).length === b.length && b.every((id) => a?.includes(id));
        if (chosen.length > 1) select({ nodes: chosen, ...also });
        else if (chosen.length === 1) {
          if (current.node !== chosen[0] || !same(current.annotations, notes))
            select({ node: chosen[0], ...also });
        } else if (notes.length) {
          if (current.node || current.nodes || !same(current.annotations, notes)) select(also);
        } else if (current.node || current.nodes || current.annotations?.length) select({});
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

  // AFD-234: a free step dragged over a wire goes into it on release.
  const spliceable = useRef(false);
  const saveMoves = useCallback(
    (moved: CanvasNode[], into?: { node: string; edge: string }) => {
      if (moved.length === 0) return;
      const positions: Record<string, Position> = {};
      const annotations: Record<string, Position> = {};
      const round = (p: Position) => ({ x: Math.round(p.x), y: Math.round(p.y) });
      // An annotation's position is in its stored form: relative to its node for a tied Note.
      for (const n of moved)
        if (n.type === 'annotation') annotations[n.id] = round(n.position);
        else if (n.type === 'flow') positions[n.id] = round(n.position);
      // Nodes still shown at in-memory auto positions are written too, so the first move freezes
      // the layout the user sees instead of letting the other nodes jump (ADR-0002).
      const stored = useUi.getState().snapshot?.doc?.layout ?? {};
      for (const n of latest.current)
        if (n.type === 'flow' && !stored[n.id] && !positions[n.id])
          positions[n.id] = round(n.position);
      const shown = { ...positions, ...annotations };
      setOptimistic(shown);
      void command(
        into
          ? { kind: 'spliceNode', ...into, positions }
          : {
              kind: 'moveNodes',
              positions,
              ...(Object.keys(annotations).length ? { annotations } : {}),
            },
      ).then((ack) => {
        if (ack.ok) return;
        // AFD-156: back to where the file has them.
        useUi.getState().dropOptimistic(shown);
        setError(ack.error ?? 'Move failed');
      });
    },
    [setOptimistic, setError],
  );
  // A Section carries the nodes and annotations wholly inside it (AFD-65): they are found when
  // the drag starts, follow by the same distance, and are saved with it in one move.
  const carry = useRef<{ id: string; from: Position; items: Map<string, Position> } | null>(null);
  const onNodeDragStart = useCallback(
    (_e: unknown, n: CanvasNode) => {
      useUi.getState().setPreview(null);
      carry.current = null;
      spliceable.current = n.type === 'flow' && editable && !!model && !spliceProblem(model, n.id);
      if (n.type !== 'annotation' || n.data.view.kind !== 'section') return;
      const inside = sectionContents(view, n.id);
      const items = new Map<string, Position>();
      for (const m of latest.current)
        if (inside.nodes.includes(m.id) || inside.annotations.includes(m.id))
          items.set(m.id, m.position);
      carry.current = { id: n.id, from: n.position, items };
    },
    [view, editable, model],
  );
  // AFD-88: guide lines while one step is dragged: a shared edge or centre (it snaps there on
  // release) and even gaps (round 1: T10, three steps lined up by eye).
  const [guide, setGuide] = useState<(Guides & { box: ArrangeBox }) | null>(null);
  const snapTo = useRef<{ id: string; at: Position } | null>(null);
  const onNodeDrag = useCallback(
    (e: unknown, n: CanvasNode, dragged: CanvasNode[] = [n]) => {
      const c = carry.current;
      if (!c || c.id !== n.id) {
        if (n.type !== 'flow' || dragged.length !== 1) return;
        // The wire under the pointer, through the dragged step: screen space, so any zoom.
        const at = e as { clientX?: number; clientY?: number };
        let wire: string | null = null;
        if (spliceable.current && model && at.clientX !== undefined && at.clientY !== undefined)
          for (const el of document.elementsFromPoint?.(at.clientX, at.clientY) ?? []) {
            const id = el.closest<HTMLElement>('.react-flow__edge')?.dataset.id;
            if (id && !spliceProblem(model, n.id, id)) {
              wire = id;
              break;
            }
          }
        if (wire !== dropWire.current) {
          dropWire.current = wire;
          setDropTarget(wire);
        }
        const boxOf = (m: FlowRFNode): ArrangeBox => ({
          id: m.id,
          x: m.position.x,
          y: m.position.y,
          width: m.data.view.width,
          height: m.data.view.height,
        });
        const others = latest.current
          .filter((m): m is FlowRFNode => m.type === 'flow' && m.id !== n.id)
          .map(boxOf);
        const g = guidesFor(boxOf(n), others);
        const lined = g.xs.length > 0 || g.ys.length > 0;
        snapTo.current = lined ? { id: n.id, at: g.snap } : null;
        setGuide(lined || g.even ? { ...g, box: { ...boxOf(n), ...g.snap } } : null);
        return;
      }
      if (dropWire.current) {
        dropWire.current = null;
        setDropTarget(null);
      }
      const dx = n.position.x - c.from.x;
      const dy = n.position.y - c.from.y;
      setNodes((ns) =>
        ns.map((m) => {
          const at = c.items.get(m.id);
          return at ? { ...m, position: { x: at.x + dx, y: at.y + dy } } : m;
        }),
      );
    },
    [model],
  );
  const onNodeDragStop = useCallback(
    (_e: unknown, _n: CanvasNode, dragged: CanvasNode[]) => {
      const c = carry.current;
      carry.current = null;
      const snap = snapTo.current;
      snapTo.current = null;
      setGuide(null);
      const moved = snap
        ? dragged.map((d) => (d.id === snap.id ? { ...d, position: snap.at } : d))
        : dragged;
      const extra = c ? latest.current.filter((m) => c.items.has(m.id)) : [];
      const wire = dropWire.current;
      dropWire.current = null;
      setDropTarget(null);
      const one = dragged.length === 1 && dragged[0]?.type === 'flow' ? dragged[0].id : undefined;
      saveMoves(
        [...moved, ...extra.filter((m) => !moved.some((d) => d.id === m.id))],
        wire && one && spliceable.current ? { node: one, edge: wire } : undefined,
      );
    },
    [saveMoves],
  );

  // Arrow keys move the focused node (React Flow); the move is saved once the keys rest (AFD-18).
  const nudge = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(nudge.current), []);
  const onNudge = useCallback(
    (e: ReactKeyboardEvent) => {
      if (!e.key.startsWith('Arrow') || e.altKey || e.ctrlKey || e.metaKey || readOnly) return;
      if (!(e.target as Element).closest?.('.react-flow__node, .react-flow__nodesselection'))
        return;
      clearTimeout(nudge.current);
      nudge.current = setTimeout(
        () =>
          saveMoves(
            latest.current.filter(
              (n) => (n.type === 'flow' || n.type === 'annotation') && n.selected,
            ),
          ),
        500,
      );
    },
    [saveMoves, readOnly],
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
      // AFD-233: a wire's end let go belongs to onReconnectEnd, which follows.
      if (reconnect.current) return;
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

  // Right-clicks open our menu instead of VS Code's (AFD-18); on a port, the port menu.
  const openMenu = useCallback(
    (e: ReactMouseEvent | MouseEvent, target: CanvasTarget) => {
      e.preventDefault();
      // The Menu key or Shift+F10 on a focused node or wire may come without a position.
      let { clientX: x, clientY: y } = e;
      if (x === 0 && y === 0 && e.target instanceof Element) {
        const r = e.target.getBoundingClientRect();
        x = r.left + 12;
        y = r.bottom;
      }
      const at = screenToFlowPosition({ x, y });
      openContextMenu({
        target,
        x,
        y,
        at: { x: Math.round(at.x), y: Math.round(at.y) },
      });
    },
    [openContextMenu, screenToFlowPosition],
  );

  useEffect(() => {
    const clear = () => {
      dropWire.current = null;
      setDropTarget(null);
    };
    window.addEventListener('dragend', clear);
    return () => window.removeEventListener('dragend', clear);
  }, []);
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
      const note = e.dataTransfer.getData(ANNOTATION_MIME) as AnnotationKind;
      if (note) {
        e.preventDefault();
        // A Note dropped on a node goes on that node.
        const hit = document.elementFromPoint(e.clientX, e.clientY);
        const on = hit?.closest<HTMLElement>('[data-node-id]')?.dataset.nodeId;
        const at = screenToFlowPosition({ x: e.clientX, y: e.clientY });
        if (note === 'note' && on) void addAnnotation('note', undefined, on);
        else void addAnnotation(note, { x: Math.round(at.x), y: Math.round(at.y) });
        return;
      }
      const type = e.dataTransfer.getData(DRAG_MIME) as NodeType;
      const wire = dropWire.current;
      dropWire.current = null;
      setDropTarget(null);
      if (!type) return;
      e.preventDefault();
      // AFD-88: a step dropped on a wire goes into it (round 1: P1, W1).
      const into = wire && INSERTABLE.includes(type) ? { insertOn: wire } : {};
      openQuickAdd({
        type,
        position: screenToFlowPosition({ x: e.clientX, y: e.clientY }),
        ...into,
      });
    },
    [openQuickAdd, screenToFlowPosition, setError],
  );

  // Where Ctrl+V pastes (AFD-17): the pointer on the canvas, else the last click on it (Edit menu,
  // palette), else the middle of the view. The context menu's Paste here carries its own spot.
  const pointer = useRef<{ x: number; y: number } | null>(null);
  const clickedAt = useRef<{ x: number; y: number } | null>(null);
  useEffect(() => {
    setPastePlace(() => {
      const pane = document.querySelector('.react-flow')?.getBoundingClientRect();
      const middle =
        pane && pane.width > 0
          ? { x: pane.left + pane.width / 2, y: pane.top + pane.height / 2 }
          : undefined;
      const at = pointer.current ?? clickedAt.current ?? middle;
      if (!at) return undefined;
      const p = screenToFlowPosition(at);
      return { x: Math.round(p.x), y: Math.round(p.y) };
    });
    return () => setPastePlace(() => undefined);
  }, [screenToFlowPosition]);

  const saved = useMemo(() => loadState<SavedState>(), []);
  const savedViewport = saved.viewports?.[level] ?? (level === ROOT ? saved.viewport : undefined);

  // AFD-42: a level opens readable (core/view/fit), once, when its nodes and the measured pane are
  // known; a viewport the user left there wins. Fit View and the zoom controls still show all.
  const opened = useRef(!!savedViewport);
  useEffect(() => {
    if (opened.current || nodes.length === 0 || paneWidth <= 0 || paneHeight <= 0) return;
    opened.current = true;
    const flowNodes = nodes.filter((n) => n.type === 'flow');
    const top = flowNodes.reduce<CanvasNode | undefined>(
      (a, n) => (!a || n.position.y < a.position.y ? n : a),
      undefined,
    );
    void setViewport(
      readableViewport(
        // An empty level opens with its card in view too (AFD-48).
        cardAt ? union(getNodesBounds(nodes), cardAt) : getNodesBounds(nodes),
        { width: paneWidth, height: paneHeight },
        top ? top.position.x + (top.width ?? 0) / 2 : undefined,
      ),
    );
  }, [nodes, paneWidth, paneHeight, setViewport, cardAt]);

  // A node shown from elsewhere (find, the failed steps, the banner's Show; AFD-48) comes to the
  // middle once its level is drawn, after the opening fit, at 100% or closer.
  useEffect(() => {
    if (!centerOn || paneWidth <= 0 || paneHeight <= 0) return;
    const v =
      view.nodes.find((n) => n.node.id === centerOn) ??
      view.annotations.find((a) => a.annotation.id === centerOn);
    if (!v) return;
    useUi.setState({ centerOn: null });
    void setCenter(v.position.x + v.width / 2, v.position.y + v.height / 2, {
      zoom: Math.max(getViewport().zoom, 1),
    });
  }, [centerOn, view.nodes, view.annotations, paneWidth, paneHeight, setCenter, getViewport]);

  // Keys that need the level's geometry (AFD-47), unless a field, menu or dialog has the focus:
  // Enter opens a selected subflow (04 §8) or moves into a node's Details, Shift+1 fits the level.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      // A chip field is contenteditable: Shift+1 there types `!` (AFD-222).
      if (
        t?.closest(
          'input, textarea, select, button, [contenteditable="true"], [role="menu"], [role="dialog"]',
        )
      )
        return;
      if (e.key === 'Enter' && !e.shiftKey) {
        const sel = useUi.getState().selection;
        const note = !sel.node && sel.annotations?.length === 1 ? sel.annotations[0] : undefined;
        if (note && editable) {
          e.preventDefault();
          editAnnotation(note);
          return;
        }
        const n = view.nodes.find((v) => v.node.id === sel.node)?.node;
        if (!n) return;
        e.preventDefault();
        if (n.type === 'subflow') setLevel(n.id);
        // After the panel shows the node: its open tab takes the focus, Tab goes on to the fields.
        else
          setTimeout(() =>
            document
              .querySelector<HTMLElement>(
                '[role="tablist"][aria-label="Details"] [aria-selected="true"]',
              )
              ?.focus(),
          );
      } else if (e.shiftKey && e.code === 'Digit1') {
        e.preventDefault();
        void fitView(FULL_FIT);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [view.nodes, setLevel, fitView, editable]);

  // Picking a node with the keyboard (AFD-47): Tab or the arrow keys walk the nodes the pick can
  // choose, Enter or Space wires the one shown. Captured before React Flow, which would otherwise
  // move a focused node with the arrows. Fields, menus and dialogs keep their keys.
  const candidates = useMemo(() => {
    const pick = useUi.getState().pick;
    return picking && pick && model
      ? pickCandidates(model, view.nodes, { mode: pick.mode, node: pick.ref.node })
      : [];
  }, [picking, model, view.nodes]);
  useEffect(() => {
    if (!picking) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (
        t?.closest(
          'input, textarea, select, [contenteditable="true"], [role="menu"], [role="dialog"]',
        )
      )
        return;
      const ui = useUi.getState();
      const back = (e.key === 'Tab' && e.shiftKey) || e.key === 'ArrowUp' || e.key === 'ArrowLeft';
      const on =
        (e.key === 'Tab' && !e.shiftKey) || e.key === 'ArrowDown' || e.key === 'ArrowRight';
      if (back || on) {
        const next = stepPick(candidates, ui.pickAt, back ? -1 : 1);
        if (!next) return;
        e.preventDefault();
        e.stopPropagation();
        ui.setPickAt(next);
      } else if ((e.key === 'Enter' || e.key === ' ') && ui.pickAt) {
        e.preventDefault();
        e.stopPropagation();
        void completePick(ui.pickAt);
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [picking, candidates]);
  // The node a keyboard pick shows comes into view when it is outside.
  useEffect(() => {
    const v = pickAt ? view.nodes.find((n) => n.node.id === pickAt) : undefined;
    if (!v || paneWidth <= 0) return;
    const { x, y, zoom } = getViewport();
    const left = v.position.x * zoom + x;
    const top = v.position.y * zoom + y;
    if (
      left >= 0 &&
      top >= 0 &&
      left + v.width * zoom <= paneWidth &&
      top + v.height * zoom <= paneHeight
    )
      return;
    void setCenter(v.position.x + v.width / 2, v.position.y + v.height / 2, { zoom });
  }, [pickAt, view.nodes, paneWidth, paneHeight, getViewport, setCenter]);

  const canvas = (
    <ReactFlow<CanvasNode>
      nodes={nodes}
      edges={allEdges}
      nodeTypes={nodeTypes}
      edgeTypes={edgeTypes}
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
      onEdgeMouseEnter={(_e, edge) => hoverWire(edge.id)}
      onEdgeMouseLeave={() => hoverWire(null)}
      onNodeDragStart={onNodeDragStart}
      onNodeDrag={onNodeDrag}
      onNodeDragStop={onNodeDragStop}
      onConnect={onConnect}
      onConnectStart={() => {
        setConnecting(true);
        useUi.getState().setPreview(null);
      }}
      onConnectEnd={onConnectEnd}
      // AFD-233: a wire's end drags to another port. The drop is read here, not by React Flow,
      // whose own check refuses an output as the place a wire can be let go.
      onReconnect={NO_RECONNECT}
      onReconnectStart={(_e, _edge, fixed) => {
        reconnect.current = true;
        setReconnecting(fixed === 'target' ? 'source' : 'target');
      }}
      onReconnectEnd={(e, edge, fixed) => {
        reconnect.current = false;
        setReconnecting(null);
        const point = 'changedTouches' in e ? e.changedTouches[0] : e;
        if (!point) return;
        const hit = document.elementFromPoint(point.clientX, point.clientY);
        // Let go outside the canvas, or on the subflow's frame: the wire stays as it was.
        if (!hit?.closest('.react-flow') || hit.closest('.react-flow__node-boundary')) return;
        if (hit.closest('.react-flow__panel, .react-flow__minimap, .react-flow__controls')) return;
        // A slip of a few pixels ends on the wire itself: not a disconnect.
        if (hit.closest<HTMLElement>('.react-flow__edge')?.dataset.id === edge.id) return;
        const node = hit.closest<HTMLElement>('[data-node-id]')?.dataset.nodeId;
        const port = hit.closest<HTMLElement>('[data-port]')?.dataset.port;
        void dropWireEnd(
          edge.id,
          fixed === 'target' ? 'source' : 'target',
          node ? { node, ...(port ? { port } : {}) } : null,
        );
      }}
      reconnectRadius={9}
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
      onNodeDoubleClick={(_e, n) => {
        if (n.type === 'flow' && n.data.view.node.type === 'subflow') setLevel(n.id);
        if (n.type === 'annotation' && editable) editAnnotation(n.id);
      }}
      zoomOnDoubleClick={false}
      // AFD-232: a double-click on empty canvas adds a node there.
      onDoubleClick={(e) => {
        if (!editable || !(e.target as Element).classList?.contains('react-flow__pane')) return;
        openQuickAdd({
          type: 'task',
          position: screenToFlowPosition({ x: e.clientX, y: e.clientY }),
        });
      }}
      onPaneClick={(e) => {
        clickedAt.current = { x: e.clientX, y: e.clientY };
        if (picking) setPick(null);
      }}
      // A right-click selects the node under it, unless that node is part of the selected group;
      // the menu acts on what is selected. On a port, the port menu opens instead.
      onNodeContextMenu={(e, n) => {
        if (n.type === 'annotation') {
          const current = useUi.getState().selection;
          if (!current.annotations?.includes(n.id)) select({ annotations: [n.id] });
          openMenu(e, { kind: 'annotation', id: n.id });
          return;
        }
        if (n.type !== 'flow') {
          openMenu(e, { kind: 'pane' });
          return;
        }
        const port = (e.target as Element).closest?.<HTMLElement>('[data-port]')?.dataset.port;
        if (port && !readOnly) {
          e.preventDefault();
          openPortMenu({ ref: { node: n.id, port }, x: e.clientX, y: e.clientY });
          return;
        }
        const current = useUi.getState().selection;
        if (current.nodes?.includes(n.id) && current.nodes.length > 1) {
          openMenu(e, { kind: 'nodes', ids: current.nodes });
          return;
        }
        if (current.node !== n.id) select({ node: n.id });
        openMenu(e, { kind: 'node', id: n.id });
      }}
      onSelectionContextMenu={(e, picked) => {
        const ids = picked.filter((n) => n.type === 'flow').map((n) => n.id);
        const notes = picked.filter((n) => n.type === 'annotation').map((n) => n.id);
        const one = ids[0];
        openMenu(
          e,
          ids.length > 1 || (one && notes.length)
            ? { kind: 'nodes', ids, ...(notes.length ? { annotations: notes } : {}) }
            : one
              ? { kind: 'node', id: one }
              : notes.length > 1
                ? { kind: 'annotations', ids: notes }
                : notes[0]
                  ? { kind: 'annotation', id: notes[0] }
                  : { kind: 'pane' },
        );
      }}
      onEdgeContextMenu={(e, edge) => {
        if (edge.className?.includes('afd-data-edge')) {
          openMenu(e, { kind: 'pane' });
          return;
        }
        if (useUi.getState().selection.edge !== edge.id) select({ edge: edge.id });
        openMenu(e, boundaryWire(edge.id) ?? { kind: 'edge', id: edge.id });
      }}
      onPaneContextMenu={(e) => openMenu(e, { kind: 'pane' })}
      onKeyDownCapture={(e) => {
        // Alt+Arrow belongs to the designer (Alt+Up: parent level), not to React Flow's nudge.
        if (!e.altKey || !e.key.startsWith('Arrow')) return;
        e.preventDefault();
        e.stopPropagation();
        if (e.key === 'ArrowUp') upLevel();
      }}
      onKeyDown={onNudge}
      onMoveStart={() => {
        openPortMenu(null);
        useUi.getState().openContextMenu(null);
        useUi.getState().setPreview(null);
      }}
      className={[
        connecting && reconnecting !== 'source' ? 'afd-connecting' : '',
        reconnecting === 'source' ? 'afd-reconnect-source' : '',
        picking ? 'afd-picking' : '',
        dimNotes ? 'afd-dim-annotations' : '',
      ]
        .filter(Boolean)
        .join(' ')}
      zIndexMode="manual"
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes(DRAG_MIME) && !readOnly) {
          const hit = document.elementFromPoint(e.clientX, e.clientY);
          const id = hit?.closest<HTMLElement>('.react-flow__edge')?.dataset.id ?? null;
          const wire = id && view.edges.some((w) => w.id === id) ? id : null;
          if (wire !== dropWire.current) {
            dropWire.current = wire;
            setDropTarget(wire);
          }
        }
        if (
          e.dataTransfer.types.includes(DRAG_MIME) ||
          e.dataTransfer.types.includes(PATTERN_MIME) ||
          e.dataTransfer.types.includes(ANNOTATION_MIME)
        )
          e.preventDefault();
      }}
      onDrop={onDrop}
      onMouseMove={(e) => {
        pointer.current = { x: e.clientX, y: e.clientY };
      }}
      onMouseLeave={() => {
        pointer.current = null;
      }}
      onMoveEnd={(_e, viewport) => {
        const state = loadState<SavedState>();
        saveState<SavedState>({ ...state, viewports: { ...state.viewports, [level]: viewport } });
      }}
      isValidConnection={(c) => c.source !== c.target}
      nodesConnectable={!readOnly && !handWritten}
      nodesDraggable={!readOnly && !handWritten}
      // Delete and Backspace are the designer's (keyboard.ts): the selection in one command.
      deleteKeyCode={null}
      onlyRenderVisibleElements={cull && !testMode}
      defaultViewport={savedViewport}
      fitViewOptions={FULL_FIT}
      minZoom={0.2}
      maxZoom={2}
      proOptions={{ hideAttribution: true }}
    >
      <Background variant={BackgroundVariant.Dots} gap={16} size={1} />
      {/* A first flow grows down from the top: the bottom left is where it leaves room. */}
      <Panel position="bottom-left">
        <FirstFlow />
      </Panel>
      <Panel position="top-right">
        <FindBar />
      </Panel>
      {cardAt ? (
        <ViewportPortal>
          <EmptyLevel at={cardAt} />
        </ViewportPortal>
      ) : null}
      {guide ? (
        <ViewportPortal>
          <DragGuides guide={guide} />
        </ViewportPortal>
      ) : null}
      <Controls showInteractive={false} position="bottom-right">
        {partly && !corner ? (
          <ControlButton
            onClick={() => setMiniAsked(!miniAsked)}
            aria-label={miniAsked ? 'Hide Mini Map' : 'Show Mini Map'}
            title={miniAsked ? 'Hide Mini Map' : 'Show Mini Map: it would cover steps here'}
          >
            <span className="codicon codicon-map" aria-hidden="true" />
          </ControlButton>
        ) : null}
      </Controls>
      {partly && (corner || miniAsked) ? (
        <MiniMap
          position={corner ?? 'bottom-left'}
          pannable
          zoomable
          ariaLabel="Mini map of the level"
          className="afd-minimap"
          style={{ width: 160, height: 110 }}
          bgColor="var(--afd-minimap-bg)"
          maskColor="var(--afd-minimap-mask)"
          nodeColor={(n) => {
            const kind = miniKind(n);
            return n.type === 'boundary' || (kind && kind !== 'note')
              ? 'transparent'
              : kind
                ? 'var(--afd-note-yellow)'
                : 'var(--afd-minimap-node)';
          }}
          nodeStrokeColor={(n) =>
            n.type === 'boundary' || miniKind(n) === 'section'
              ? 'var(--afd-neutral)'
              : 'transparent'
          }
          nodeBorderRadius={4}
        />
      ) : null}
    </ReactFlow>
  );
  return (
    <WireHover.Provider value={hoverWire}>
      <NodeBoxes.Provider value={boxes}>{canvas}</NodeBoxes.Provider>
    </WireHover.Provider>
  );
}

/** AFD-88: the lines a dragged step shares with others, and a mark when its gaps are even. */
function DragGuides({ guide }: { guide: Guides & { box: ArrangeBox } }) {
  const { box } = guide;
  const reach = 2000;
  return (
    <div className="afd-guides" aria-hidden="true" data-guides={guide.xs.length + guide.ys.length}>
      {guide.xs.map((x) => (
        <div
          key={`x${x}`}
          className="afd-guide v"
          style={{ left: x, top: box.y - reach, height: 2 * reach }}
        />
      ))}
      {guide.ys.map((y) => (
        <div
          key={`y${y}`}
          className="afd-guide h"
          style={{ top: y, left: box.x - reach, width: 2 * reach }}
        />
      ))}
      {guide.even ? (
        <div
          className="afd-guide-even"
          data-even={guide.even}
          style={
            guide.even === 'vertical'
              ? { left: box.x + box.width + 8, top: box.y + box.height / 2 - 9 }
              : { left: box.x + box.width / 2 - 30, top: box.y + box.height + 6 }
          }
        >
          even gaps
        </div>
      ) : null}
    </div>
  );
}

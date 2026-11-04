// Node on the canvas: a cheap shell with ports, plus a memoized body (07 §6). Semantic zoom
// (D-19): below zoom 0.45 the body collapses to the title only ("far"); at default zoom it shows
// its status and what it runs (AFD-42), or the active lens's two chips (M8); from zoom 1.4 the box
// lists summary rows. A selected node's Details are docked on the right (AFD-43), not on the canvas.
// Ports follow D-14: every port of the type is rendered (so wires can reach them and positions stay
// fixed), but at rest only connected, open-fail and open-on-purpose ports show; hover, selection,
// an open port menu or a wire being dragged reveal the rest with labels (CSS in styles/).
import {
  Handle,
  type Node,
  type NodeProps,
  Position,
  type ReactFlowState,
  useStore,
  useUpdateNodeInternals,
} from '@xyflow/react';
import {
  Fragment,
  type KeyboardEvent,
  type MouseEvent,
  memo,
  useEffect,
  useMemo,
  useRef,
} from 'react';
import { purposeOf } from '../../core/flow/format';
import { modelOf } from '../../core/flow/model';
import type { PortSide } from '../../core/flow/ports';
import type { FlowNode, NodeType, Ulid } from '../../core/flow/types';
import { summaryRows } from '../../core/lens';
import { formatSeconds } from '../../core/run/view';
import { codeState } from '../../core/view/codeState';
import { shownOn } from '../../core/view/find';
import { subLine } from '../../core/view/nodeFace';
import { portHint } from '../../core/view/portHints';
import { STATE_LABEL } from '../constants';
import { useUi } from '../store';
import type { NodeView, PortView } from '../viewModel';
import { StatusIcon } from './StatusIcon';

export type FlowNodeData = { view: NodeView };
export type FlowRFNode = Node<FlowNodeData, 'flow'>;

const SIDE: Record<PortSide, Position> = {
  top: Position.Top,
  bottom: Position.Bottom,
  left: Position.Left,
  right: Position.Right,
};

const farSelector = (s: ReactFlowState) => s.transform[2] < 0.45;
/** D-19 "near": from this zoom the node box lists summary rows. */
export const NEAR_ZOOM = 1.4;
const nearSelector = (s: ReactFlowState) => s.transform[2] >= NEAR_ZOOM;
/** Fork and merge nodes are drawn as bars with their title only (AFD-42). */
const BAR: ReadonlySet<string> = new Set(['parallel', 'join']);

/** Window point next to a port where its menu opens. */
export function menuAnchor(el: Element, side: PortSide): { x: number; y: number } {
  const r = el.getBoundingClientRect();
  if (side === 'left') return { x: r.left - 8, y: r.top - 8 };
  if (side === 'bottom') return { x: r.left - 8, y: r.bottom + 8 };
  return { x: r.right + 8, y: r.top - 8 };
}

/**
 * A port. On the selected node its ports are tab stops (AFD-47): Enter or Space opens the port's
 * menu, as a click does; on other nodes they stay out of the Tab order, so Tab walks nodes.
 */
function PortHandle({
  nodeId,
  type,
  port,
  focusable,
}: {
  nodeId: string;
  type: NodeType;
  port: PortView;
  focusable: boolean;
}) {
  const openPortMenu = useUi((s) => s.openPortMenu);
  const along = `${Math.round(port.offset * 100)}%`;
  const style = port.side === 'top' || port.side === 'bottom' ? { left: along } : { top: along };
  const isOutput = port.direction === 'out';
  // Code and Run modes read the graph; wiring and port menus belong to Design (AFD-45).
  const locked = useUi((s) => s.mode !== 'design');
  const open = (el: HTMLDivElement) => {
    // While picking a target, the click belongs to the node (FlowCanvas onNodeClick).
    if (useUi.getState().pick || locked) return;
    openPortMenu({ ref: { node: nodeId, port: port.name }, ...menuAnchor(el, port.side) });
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    // Not the node's own Enter (select, Details) nor React Flow's.
    e.preventDefault();
    e.stopPropagation();
    open(e.currentTarget);
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
      title={[port.name, portHint(port.name, type), STATE_LABEL[port.state], 'click for options']
        .filter(Boolean)
        .join(' · ')}
      aria-label={`Port ${port.name}, ${STATE_LABEL[port.state]}`}
      role="button"
      aria-haspopup={locked ? undefined : 'menu'}
      aria-disabled={locked || undefined}
      tabIndex={focusable && !locked ? 0 : -1}
      onClick={(e: MouseEvent<HTMLDivElement>) => open(e.currentTarget)}
      onKeyDown={onKeyDown}
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
  const { count, state, tone } = codeState(node, code, issue, ran);
  return (
    <>
      <div className="afd-node-sub mono afd-node-artifact" title={code.artifact}>
        {code.artifact}
      </div>
      <div className={`afd-node-code tone-${tone}`} data-code-state={state}>
        {count ? `${count} · ${state}` : state}
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
  // AFD-81: the step a live run is in (a subflow: a step inside it), with what has happened so far.
  if (r.state === 'running') {
    const so = [r.hosts > 0 ? `${r.hosts} host${r.hosts === 1 ? '' : 's'}` : ''];
    if (r.failed > 0) so.push(`${r.failed} failed`);
    return (
      <div className="afd-node-run tone-running" data-run-state="running">
        {['running…', ...so.filter(Boolean)].join(' · ')}
      </div>
    );
  }
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

const NodeBody = memo(function NodeBody({ node, near }: { node: FlowNode; near: boolean }) {
  const implementation = useUi((s) => s.mode === 'code');
  const runMode = useUi((s) => s.mode === 'run');
  const lens = useUi((s) => s.lens);
  if (node.type === 'start' || node.type === 'end' || BAR.has(node.type)) {
    return (
      <>
        <span className="afd-node-title">{node.title}</span>
        {BAR.has(node.type) ? null : <LensChips id={node.id} />}
      </>
    );
  }
  const status = node.status ?? 'draft';
  const head = (
    <div className="afd-node-head">
      <StatusIcon status={status} />
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
  const sub = subLine(node);
  return (
    <>
      {head}
      <div className={`afd-node-sub${node.impl?.ref || node.condition ? ' mono' : ''}`} title={sub}>
        {sub}
      </div>
    </>
  );
});

export const FlowNodeView = memo(function FlowNodeView({ data, selected }: NodeProps<FlowRFNode>) {
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
  // AFD-91: a lit step inside a subflow lights that subflow; with nothing of it on this level,
  // nothing dims (round 2: S11).
  const lit = useUi((s) => {
    if (!s.highlight) return '';
    const doc = s.snapshot?.doc;
    const shown = doc ? shownOn(modelOf(doc), s.highlight, s.level) : s.highlight;
    if (shown.length === 0) return '';
    return shown.includes(node.id) ? 'lens-hit' : 'lens-dim';
  });
  // D-14: the node stays active while its port menu is open, so its ports do not vanish.
  const active = useUi((s) => s.portMenu?.ref.node === node.id);
  // The node a keyboard pick would choose (AFD-47).
  const pickAt = useUi((s) => s.pick !== null && s.pickAt === node.id);
  const runMode = useUi((s) => s.mode === 'run');
  const runState = useUi((s) => (s.mode === 'run' ? s.runNodes?.[node.id]?.state : undefined));
  // AFD-85: changed outside the designer (a subflow: a step inside it was).
  const outside = useUi((s) =>
    s.outside?.nodes.includes(node.id)
      ? 'outside-mark'
      : s.outsideAround.includes(node.id)
        ? 'outside-inside'
        : '',
  );
  const classes = [
    outside,
    runMode ? 'run-mode' : '',
    runState ? `run-${runState}` : '',
    'afd-node',
    `type-${node.type}`,
    `status-${node.status ?? 'draft'}`,
    purposeOf(node) ? 'handler' : '',
    node.type === 'end' && node.outcome === 'failed' ? 'outcome-failed' : '',
    selected ? 'selected' : '',
    active ? 'active' : '',
    pickAt ? 'afd-pick-at' : '',
    lit,
  ]
    .filter(Boolean)
    .join(' ');
  return (
    // The lens chips are also on the root, so tests read them at any zoom (far hides the body).
    <div
      className={classes}
      data-node-id={node.id}
      data-run-state={runState}
      data-lens={lensChips}
      data-outside={outside || undefined}
    >
      {/* Hover margin around the node and its port labels (D-14 detail). */}
      <div className="afd-hover-zone" aria-hidden="true" />
      {ports.map((p) => (
        <PortHandle
          key={p.name}
          nodeId={node.id}
          type={node.type}
          port={p}
          focusable={selected || active}
        />
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
    </div>
  );
});

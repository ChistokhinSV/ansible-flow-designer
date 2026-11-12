// Runs port menu items (04 §3). Shared by the canvas port menu, the inspector and the palette, so
// every entry point produces the same commands; each command is one undo step on the host.
import { modelOf } from '../core/flow/model';
import type { PatternId } from '../core/flow/patterns';
import { freeOutput, nextFrom, type PortMenuItem, patternTarget } from '../core/flow/portMenu';
import { portDirection } from '../core/flow/ports';
import type { NodeType, PortRef, Position, Ulid } from '../core/flow/types';
import { run } from './actions';
import { attachAnnotation } from './annotationActions';
import { menuAnchor } from './canvas/FlowNodeView';
import { canvasPlace } from './clipboard';
import { INSERTABLE } from './panels/QuickAdd';
import { useUi } from './store';
import { besidePort, freeSpot, levelView, unplacedPositions } from './viewModel';

function currentView() {
  const { snapshot, optimistic } = useUi.getState();
  if (!snapshot?.doc) return undefined;
  const view = levelView(snapshot, optimistic, useUi.getState().level);
  return { doc: snapshot.doc, view, freeze: unplacedPositions(view, snapshot.doc.layout) };
}

export async function applyPatternAt(pattern: PatternId, from: PortRef): Promise<void> {
  const ctx = currentView();
  if (!ctx) return;
  const ack = await run({
    kind: 'applyPattern',
    pattern,
    from,
    position: besidePort(ctx.view, from.node, from.port),
    freeze: ctx.freeze,
  });
  if (ack.ok && ack.created) useUi.getState().select({ node: ack.created });
}

/** Palette click or drop on a node: the pattern goes to the node's first open port it fits. */
export async function dropPattern(pattern: PatternId, node: Ulid, port?: string): Promise<void> {
  const doc = useUi.getState().snapshot?.doc;
  if (!doc) return;
  const target = patternTarget(modelOf(doc), node, pattern, port);
  if (!target) {
    useUi.getState().setError('This node has no open port this pattern fits');
    return;
  }
  await applyPatternAt(pattern, { node, port: target });
}

function insertPosition(edge: Ulid): Position | undefined {
  const ctx = currentView();
  const e = ctx?.view.edges.find((x) => x.id === edge);
  const a = ctx?.view.nodes.find((n) => n.node.id === e?.source);
  const b = ctx?.view.nodes.find((n) => n.node.id === e?.target);
  if (!ctx || !a || !b) return undefined;
  const mid = { x: (a.position.x + b.position.x) / 2 + 40, y: (a.position.y + b.position.y) / 2 };
  return freeSpot(ctx.view, mid, { width: a.width, height: a.height });
}

export async function runPortItem(item: PortMenuItem, ref: PortRef): Promise<void> {
  const ui = useUi.getState();
  ui.openPortMenu(null);
  switch (item.kind) {
    case 'pattern':
      await applyPatternAt(item.pattern, ref);
      return;
    case 'quickAdd': {
      const ctx = currentView();
      ui.openQuickAdd({
        type: 'task',
        connectFrom: ref,
        title: item.title,
        position: ctx ? besidePort(ctx.view, ref.node, ref.port) : undefined,
      });
      return;
    }
    case 'insert':
      ui.openQuickAdd({ type: 'task', insertOn: item.edge, position: insertPosition(item.edge) });
      return;
    case 'pick':
      ui.setPick({ mode: item.mode, ref, edge: item.edge });
      return;
    case 'disconnect':
      await run({ kind: 'disconnect', edge: item.edge });
      return;
    case 'decide':
      ui.setDecide(ref);
      return;
    case 'reopen':
      await run({ kind: 'clearDecision', node: ref.node, port: ref.port });
      return;
    case 'enable':
    case 'disable':
      await run({
        kind: 'setPortEnabled',
        node: ref.node,
        port: ref.port,
        enabled: item.kind === 'enable',
      });
      return;
    case 'later':
      return;
  }
}

/** Insert Node on This Wire, from the wire's + (AFD-231) or its menu. */
export function insertOnWire(edge: Ulid): void {
  const ui = useUi.getState();
  const source = ui.snapshot?.doc ? modelOf(ui.snapshot.doc).edges.get(edge)?.edge.from.node : '';
  // On a level laid out automatically the new step gets no position: the layout puts it in line.
  const auto = !!source && source in (ui.snapshot?.autoPositions ?? {});
  ui.openQuickAdd({
    type: 'task',
    insertOn: edge,
    ...(auto ? {} : { position: insertPosition(edge) }),
  });
}

/**
 * AFD-233: a wire's end dragged off its port and let go: over a node or a port the wire now ends
 * (or starts) there; over empty canvas it is disconnected. `end` is the end that was dragged.
 */
export async function dropWireEnd(
  edgeId: Ulid,
  end: 'source' | 'target',
  on: { node: Ulid; port?: string } | null,
): Promise<void> {
  const ui = useUi.getState();
  const doc = ui.snapshot?.doc;
  const edge = doc ? modelOf(doc).edges.get(edgeId)?.edge : undefined;
  if (!doc || !edge) return;
  if (!on) {
    await run({ kind: 'disconnect', edge: edgeId });
    return;
  }
  if (end === 'target') {
    const port = on.port && portDirection(on.port) === 'in' ? on.port : 'in';
    if (edge.to.node === on.node && edge.to.port === port) return;
    await run({ kind: 'rewire', edge: edgeId, to: { node: on.node, port } });
    return;
  }
  // The source end: the port it was dropped on, else the node's first main output still open.
  const next = nextFrom(modelOf(doc), on.node);
  const port =
    on.port && portDirection(on.port) === 'out'
      ? on.port
      : edge.from.node === on.node
        ? edge.from.port
        : next && !next.insertOn
          ? next.port
          : undefined;
  if (!port) {
    ui.setError('That node has no open output to wire from');
    return;
  }
  if (edge.from.node === on.node && edge.from.port === port) return;
  await run({ kind: 'rewireFrom', edge: edgeId, from: { node: on.node, port } });
}

/** Finishes a pick started from a port menu with the clicked node. */
export async function completePick(target: Ulid): Promise<void> {
  const { pick, snapshot, setPick, setError } = useUi.getState();
  if (!pick || !snapshot?.doc) return;
  setPick(null);
  switch (pick.mode) {
    case 'to':
      await run({ kind: 'connect', from: pick.ref, to: { node: target, port: 'in' } });
      return;
    case 'rewire':
      if (pick.edge)
        await run({ kind: 'rewire', edge: pick.edge, to: { node: target, port: 'in' } });
      return;
    case 'attach':
      await attachAnnotation(pick.ref.node, target);
      return;
    case 'from': {
      const port = freeOutput(modelOf(snapshot.doc), target);
      if (!port) {
        setError('That node has no free output to wire from');
        return;
      }
      await run({ kind: 'connect', from: { node: target, port }, to: pick.ref });
      return;
    }
  }
}

/**
 * Add Next Node from a node's main output, or onto its wire when it has one (`nextFrom`). On a
 * level laid out automatically the new step gets no position, so the layout puts it in line.
 */
export function addNextNode(from: PortRef, insertOn?: Ulid): void {
  const auto = from.node in (useUi.getState().snapshot?.autoPositions ?? {});
  if (insertOn && auto) useUi.getState().openQuickAdd({ type: 'task', insertOn });
  else
    void runPortItem(
      insertOn
        ? { kind: 'insert', label: 'Add Next Node', edge: insertOn }
        : { kind: 'quickAdd', label: 'Add Next Node' },
      from,
    );
}

/**
 * Add a node from the keyboard (N, AFD-47) or the empty-level card (AFD-48): Add Next Node after
 * `from` (else the one selected node), else Add Node where a paste would land.
 */
export function addNode(from?: Ulid): void {
  const ui = useUi.getState();
  const doc = ui.snapshot?.doc;
  if (!doc) return;
  const one = from ?? ui.selection.node;
  const next = one ? nextFrom(modelOf(doc), one) : undefined;
  if (one && next) addNextNode({ node: one, port: next.port }, next.insertOn);
  else {
    const position = canvasPlace();
    ui.openQuickAdd({ type: 'task', ...(position ? { position } : {}) });
  }
}

/**
 * AFD-96 (W1): a palette click adds its step where the flow goes on: after the one selected step,
 * wired (onto its wire when it has one), or onto Start → Done on a level with nothing else. False
 * when neither applies, and the caller places it as before.
 */
export function addFromPalette(type: NodeType): boolean {
  const ui = useUi.getState();
  const doc = ui.snapshot?.doc;
  if (!doc || !INSERTABLE.includes(type)) return false;
  const model = modelOf(doc);
  const steps = model.levels.get(ui.level)?.nodes ?? [];
  const onlyEnds = steps.every((n) => n.type === 'start' || n.type === 'end');
  const from =
    ui.selection.node ?? (onlyEnds ? steps.find((n) => n.type === 'start')?.id : undefined);
  const next = from ? nextFrom(model, from) : undefined;
  if (!from || !next) return false;
  const auto = from in (ui.snapshot?.autoPositions ?? {});
  if (next.insertOn)
    ui.openQuickAdd({
      type,
      insertOn: next.insertOn,
      ...(auto ? {} : { position: insertPosition(next.insertOn) }),
    });
  else {
    const ctx = currentView();
    ui.openQuickAdd({
      type,
      connectFrom: { node: from, port: next.port },
      position: ctx ? besidePort(ctx.view, from, next.port) : undefined,
    });
  }
  return true;
}

/** Shows the node, then opens the port's menu beside it once it is on screen (AFD-72, AFD-73). */
export function openPortMenuSoon(ref: PortRef): void {
  useUi.getState().reveal(ref.node);
  setTimeout(() => {
    const el = document.querySelector(
      `.react-flow__node[data-id="${ref.node}"] [data-port="${ref.port}"]`,
    );
    if (el) useUi.getState().openPortMenu({ ref, ...menuAnchor(el, 'right') });
  }, 300);
}

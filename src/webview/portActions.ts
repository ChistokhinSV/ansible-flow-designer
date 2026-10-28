// Runs port menu items (04 §3). Shared by the canvas port menu, the inspector and the palette, so
// every entry point produces the same commands; each command is one undo step on the host.
import { buildModel } from '../core/flow/model';
import type { PatternId } from '../core/flow/patterns';
import { freeOutput, type PortMenuItem, patternTarget } from '../core/flow/portMenu';
import type { PortRef, Position, Ulid } from '../core/flow/types';
import { run } from './actions';
import { useUi } from './store';
import { besidePort, freeSpot, levelView, unplacedPositions } from './viewModel';

function currentView() {
  const { snapshot, optimistic } = useUi.getState();
  if (!snapshot?.doc) return undefined;
  const view = levelView(snapshot, optimistic);
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
  const target = patternTarget(buildModel(doc), node, pattern, port);
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
    case 'from': {
      const port = freeOutput(buildModel(snapshot.doc), target);
      if (!port) {
        setError('That node has no free output to wire from');
        return;
      }
      await run({ kind: 'connect', from: { node: target, port }, to: pick.ref });
      return;
    }
  }
}

// Drift actions from the "Design vs code" panel (M6, D-29). Design-side actions are flow commands
// (one undo step each); code-side ones go to the host (open code, stubs, specs, re-sync).
import type { DriftAction } from '../core/drift/types';
import { buildModel } from '../core/flow/model';
import { run } from './actions';
import { type Ack, hostAction, send } from './bus';
import { useUi } from './store';

const GAP_Y = 140;

/** The ack can arrive before the snapshot with the new node: reveal it once it is there. */
function revealWhenShown(node: string, timeout = 3000): Promise<void> {
  const has = () => {
    const doc = useUi.getState().snapshot?.doc;
    return !!doc && buildModel(doc).nodes.has(node);
  };
  return new Promise((resolve) => {
    const done = () => {
      off();
      clearTimeout(timer);
      useUi.getState().reveal(node);
      resolve();
    };
    const off = useUi.subscribe((s, prev) => {
      if (s.snapshot !== prev.snapshot && has()) done();
    });
    const timer = setTimeout(() => {
      off();
      resolve();
    }, timeout);
    if (has()) done();
  });
}

/** `wait_for_convergence` → `Wait for convergence`. */
export function titleOf(file: string): string {
  const words = file.replaceAll(/[_-]+/g, ' ').trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export async function runDriftAction(action: DriftAction): Promise<Ack | undefined> {
  const ui = useUi.getState();
  const doc = ui.snapshot?.doc;
  if (!doc) return undefined;
  const model = buildModel(doc);
  const node = 'node' in action ? model.nodes.get(action.node)?.node : undefined;
  switch (action.kind) {
    case 'renameOutput': {
      const field = node?.outputs?.[action.from];
      if (!field) return undefined;
      return run({
        kind: 'setContractField',
        target: action.node,
        side: 'outputs',
        name: action.from,
        rename: action.to,
        field,
      });
    }
    case 'removeOutput':
      return run({
        kind: 'setContractField',
        target: action.node,
        side: 'outputs',
        name: action.name,
        field: null,
      });
    case 'setOutputFrom': {
      const field = node?.outputs?.[action.name];
      if (!field) return undefined;
      return run({
        kind: 'setContractField',
        target: action.node,
        side: 'outputs',
        name: action.name,
        field: { ...field, from: action.from },
      });
    }
    case 'addInput':
      return run({
        kind: 'setContractField',
        target: action.node,
        side: 'inputs',
        name: action.name,
        field: action.field,
      });
    case 'removeInput':
      return run({
        kind: 'setContractField',
        target: action.node,
        side: 'inputs',
        name: action.name,
        field: null,
      });
    case 'openCode':
      send({ type: 'openCode', path: action.path, line: action.line });
      return undefined;
    case 'addToSubflow': {
      // After the last inner step, unwired (decision M6-4): the user decides where it runs.
      const inner = model.levels.get(action.subflow)?.nodes ?? [];
      const at = inner
        .map((n) => (n ? (doc.layout?.[n.id] ?? ui.snapshot?.autoPositions[n.id]) : undefined))
        .filter((p): p is { x: number; y: number } => !!p);
      const last = at.reduce((a, b) => (b.y > a.y ? b : a), at[0] ?? { x: 40, y: 40 - GAP_Y });
      const ack = await run({
        kind: 'addNode',
        parent: action.subflow,
        type: 'task',
        title: titleOf(action.tasksFrom),
        impl: { kind: 'role', ref: action.role, params: { tasks_from: action.tasksFrom } },
        position: { x: Math.round(last.x), y: Math.round(last.y + GAP_Y) },
      });
      const created = ack.created;
      if (ack.ok && created) await revealWhenShown(created);
      return ack;
    }
    case 'ignore': {
      const item = ui.drift?.items.find((i) => i.node === action.node && i.id === action.item);
      ui.setIgnore({
        node: action.node,
        item: action.item,
        title: item?.title ?? '',
        label: item?.label ?? '',
      });
      return undefined;
    }
    case 'unignore':
      return run({ kind: 'clearDriftIgnore', node: action.node, item: action.item });
    case 'bind':
      ui.openProperties(action.node, 'implementation', action.bindKind);
      return undefined;
    default: {
      const ack = await hostAction(action);
      if (!ack.ok) useUi.getState().setError(ack.error ?? 'The action failed');
      return ack;
    }
  }
}

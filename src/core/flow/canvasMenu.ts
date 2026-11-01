// What a right-click on the canvas offers (AFD-18), by target and mode. Pure data: the webview
// renders the entries and runs their actions, so tests can check every menu without React.
// Design and Implementation offer the edits the canvas allows there; Run mode only reads.
import { type FlowModel, ROOT } from './model';
import type { OpenPort } from './openPorts';
import { freeOutput, type PortMenuItem, portMenu } from './portMenu';
import { NODE_STATUSES, type NodeStatus, type PortRef, type Ulid } from './types';

export type CanvasMode = 'design' | 'code' | 'run';

export type CanvasTarget =
  | { kind: 'node'; id: Ulid }
  | { kind: 'nodes'; ids: Ulid[] }
  | { kind: 'edge'; id: Ulid }
  /** The boundary frame's entry wire (D-23). */
  | { kind: 'entry'; subflow: Ulid }
  /** A boundary exit: an inner output leaving through the parent's `port`. */
  | { kind: 'exit'; subflow: Ulid; edge: string; from: PortRef; port: string }
  | { kind: 'pane' };

/** Keys of the shortcut table (webview `shortcuts.ts`), shown next to an item. */
export type ShortcutId =
  | 'open'
  | 'rename'
  | 'cut'
  | 'copy'
  | 'paste'
  | 'duplicate'
  | 'delete'
  | 'up'
  | 'menu'
  | 'help'
  | 'addNode'
  | 'selectAll'
  | 'fit';

export type CanvasAction =
  | { do: 'openSubflow'; node: Ulid }
  | { do: 'properties'; node: Ulid; tab?: 'binding' }
  | { do: 'rename'; node: Ulid }
  | { do: 'setStatus'; node: Ulid; status: NodeStatus }
  | { do: 'port'; ref: PortRef; item: PortMenuItem }
  | { do: 'addNext'; from: PortRef }
  | { do: 'cut' | 'copy' | 'duplicate' | 'delete'; nodes: Ulid[]; edges?: Ulid[] }
  | { do: 'extract'; nodes: Ulid[] }
  | { do: 'showInText'; node: Ulid }
  | { do: 'peekCode'; node: Ulid }
  | { do: 'removeEntry'; subflow: Ulid }
  | { do: 'removeExit'; subflow: Ulid; from: PortRef; port: string }
  | { do: 'editReason'; edge: string }
  /** At the menu's own spot. */
  | { do: 'paste' }
  | { do: 'addNode' }
  | { do: 'selectAll' }
  | { do: 'tidyUp' }
  | { do: 'fitView' }
  | { do: 'upLevel' };

export type CanvasMenuEntry =
  | {
      type: 'item';
      label: string;
      /** Codicon name, without the `codicon-` prefix. */
      icon?: string;
      action: CanvasAction;
      shortcut?: ShortcutId;
      /** Radio items (status): the current one. */
      checked?: boolean;
      /** Set when the item is shown but cannot run now: why. */
      disabled?: string;
    }
  | { type: 'submenu'; label: string; icon?: string; items: CanvasMenuEntry[] }
  | { type: 'separator' };

export interface CanvasMenuContext {
  mode: CanvasMode;
  /** The open level: `root` or a subflow node id. */
  level: string;
  /** The text has YAML errors (or lacks IDs): the canvas shows a model and refuses edits. */
  stale: boolean;
  /** Why edits are refused, when not for YAML errors. */
  why?: string;
  openPorts: readonly OpenPort[];
  hasPlay: (node: Ulid) => boolean;
}

const STALE = 'Fix the YAML errors first';

function item(
  label: string,
  action: CanvasAction,
  extra: Partial<Extract<CanvasMenuEntry, { type: 'item' }>> = {},
): CanvasMenuEntry {
  return { type: 'item', label, action, ...extra };
}

/** Separators only between groups that have items; none at the ends. */
function groups(...parts: CanvasMenuEntry[][]): CanvasMenuEntry[] {
  const out: CanvasMenuEntry[] = [];
  for (const part of parts.filter((p) => p.length > 0)) {
    if (out.length > 0) out.push({ type: 'separator' });
    out.push(...part);
  }
  return out;
}

const PORT_ICON: Partial<Record<PortMenuItem['kind'], string>> = {
  pattern: 'zap',
  quickAdd: 'add',
  insert: 'insert',
  pick: 'link',
  disconnect: 'debug-disconnect',
  decide: 'pass',
  reopen: 'discard',
};

function portItems(model: FlowModel, ref: PortRef, kinds?: PortMenuItem['kind'][]) {
  return (portMenu(model, ref)?.items ?? [])
    .filter((i) => i.kind !== 'later' && (!kinds || kinds.includes(i.kind)))
    .map((i) => item(i.label, { do: 'port', ref, item: i }, { icon: PORT_ICON[i.kind] }));
}

function nodeMenu(model: FlowModel, id: Ulid, ctx: CanvasMenuContext): CanvasMenuEntry[] {
  const node = model.nodes.get(id)?.node;
  if (!node) return [];
  const edit = ctx.mode === 'design';
  const lock = ctx.stale ? { disabled: ctx.why ?? STALE } : {};
  const ends = node.type === 'start' || node.type === 'end';
  const open: CanvasMenuEntry[] = [];
  if (node.type === 'subflow')
    open.push(
      item(
        'Open Subflow',
        { do: 'openSubflow', node: id },
        { icon: 'arrow-right', shortcut: 'open' },
      ),
    );
  if (node.type === 'task' || node.type === 'subflow') {
    open.push(
      item(
        'Details…',
        { do: 'properties', node: id },
        // Enter opens a subflow; on any other node it moves into the Details (AFD-47).
        {
          icon: 'settings-gear',
          ...(node.type === 'subflow' ? {} : { shortcut: 'open' as const }),
        },
      ),
    );
    // Binding stays editable in Code mode, where the graph is read-only (AFD-45).
    if (ctx.mode !== 'run')
      open.push(
        item(
          'Binding…',
          { do: 'properties', node: id, tab: 'binding' },
          {
            icon: 'plug',
          },
        ),
      );
  }

  const design: CanvasMenuEntry[] = [];
  if (ctx.mode === 'design')
    design.push(
      item('Rename', { do: 'rename', node: id }, { icon: 'edit', shortcut: 'rename', ...lock }),
    );
  if (edit && !ends)
    design.push({
      type: 'submenu',
      label: 'Status',
      icon: 'circle-large-outline',
      items: NODE_STATUSES.map((status) =>
        item(
          status,
          { do: 'setStatus', node: id, status },
          { checked: node.status === status, ...lock },
        ),
      ),
    });
  if (edit && !ctx.stale)
    for (const p of ctx.openPorts.filter((o) => o.node === id))
      design.push({
        type: 'submenu',
        label: `Open Port ${p.port}`,
        icon: 'warning',
        items: portItems(model, { node: id, port: p.port }),
      });
  const next = edit ? freeOutput(model, id) : undefined;
  if (next)
    design.push(
      item(
        'Add Next Node…',
        { do: 'addNext', from: { node: id, port: next } },
        { icon: 'add', shortcut: 'addNode', ...lock },
      ),
    );

  const one = [id];
  const clip: CanvasMenuEntry[] = [];
  if (edit && node.type !== 'start')
    clip.push(item('Cut', { do: 'cut', nodes: one }, { shortcut: 'cut', ...lock }));
  clip.push(item('Copy', { do: 'copy', nodes: one }, { icon: 'copy', shortcut: 'copy' }));
  if (edit && node.type !== 'start')
    clip.push(
      item(
        'Duplicate',
        { do: 'duplicate', nodes: one },
        { icon: 'files', shortcut: 'duplicate', ...lock },
      ),
    );

  const code: CanvasMenuEntry[] = [
    item('Open in Text Editor', { do: 'showInText', node: id }, { icon: 'go-to-file' }),
  ];
  if (ctx.hasPlay(id)) code.push(item('Peek Code', { do: 'peekCode', node: id }, { icon: 'code' }));

  const remove = edit
    ? [item('Delete', { do: 'delete', nodes: one }, { icon: 'trash', shortcut: 'delete', ...lock })]
    : [];
  return groups(open, design, clip, code, remove);
}

function groupMenu(model: FlowModel, ids: Ulid[], ctx: CanvasMenuContext): CanvasMenuEntry[] {
  const nodes = ids.map((id) => model.nodes.get(id)?.node).filter((n) => !!n);
  const edit = ctx.mode === 'design';
  const lock = ctx.stale ? { disabled: ctx.why ?? STALE } : {};
  const clip: CanvasMenuEntry[] = [];
  if (edit) clip.push(item('Cut', { do: 'cut', nodes: ids }, { shortcut: 'cut', ...lock }));
  clip.push(item('Copy', { do: 'copy', nodes: ids }, { icon: 'copy', shortcut: 'copy' }));
  if (edit)
    clip.push(
      item(
        'Duplicate',
        { do: 'duplicate', nodes: ids },
        { icon: 'files', shortcut: 'duplicate', ...lock },
      ),
    );
  const more: CanvasMenuEntry[] = [];
  if (ctx.mode === 'design') {
    const ends = nodes.some((n) => n.type === 'start' || n.type === 'end');
    more.push(
      item(
        'Extract into Subflow…',
        { do: 'extract', nodes: ids },
        {
          icon: 'type-hierarchy-sub',
          ...(ends ? { disabled: 'Start and end nodes stay on their level' } : lock),
        },
      ),
    );
  }
  const remove = edit
    ? [item('Delete', { do: 'delete', nodes: ids }, { icon: 'trash', shortcut: 'delete', ...lock })]
    : [];
  return groups(clip, more, remove);
}

function paneMenu(ctx: CanvasMenuContext): CanvasMenuEntry[] {
  const edit = ctx.mode === 'design';
  const lock = ctx.stale ? { disabled: ctx.why ?? STALE } : {};
  const add = edit
    ? [
        item('Paste Here', { do: 'paste' }, { icon: 'clippy', shortcut: 'paste', ...lock }),
        item('Add Node Here…', { do: 'addNode' }, { icon: 'add', shortcut: 'addNode', ...lock }),
      ]
    : [];
  const view: CanvasMenuEntry[] = [
    item('Select All', { do: 'selectAll' }, { icon: 'selection', shortcut: 'selectAll' }),
  ];
  if (edit) view.push(item('Tidy Up', { do: 'tidyUp' }, { icon: 'layout', ...lock }));
  view.push(item('Fit View', { do: 'fitView' }, { icon: 'screen-full', shortcut: 'fit' }));
  const nav =
    ctx.level !== ROOT
      ? [item('Up to Parent', { do: 'upLevel' }, { icon: 'arrow-up', shortcut: 'up' })]
      : [];
  return groups(add, view, nav);
}

export function canvasMenu(
  model: FlowModel,
  target: CanvasTarget,
  ctx: CanvasMenuContext,
): CanvasMenuEntry[] {
  const edit = ctx.mode === 'design' && !ctx.stale;
  switch (target.kind) {
    case 'node':
      return nodeMenu(model, target.id, ctx);
    case 'nodes':
      return groupMenu(model, target.ids, ctx);
    case 'edge': {
      const edge = model.edges.get(target.id)?.edge;
      if (!edge || !edit) return paneMenu(ctx);
      const wire = portItems(model, edge.from, ['insert', 'pick', 'disconnect']);
      return wire.length > 0 ? wire : paneMenu(ctx);
    }
    case 'entry':
      return edit
        ? [
            item(
              'Remove Entry',
              { do: 'removeEntry', subflow: target.subflow },
              { icon: 'debug-disconnect' },
            ),
          ]
        : paneMenu(ctx);
    case 'exit': {
      if (!edit) return paneMenu(ctx);
      const reason =
        ctx.mode === 'design'
          ? [item('Edit Reason…', { do: 'editReason', edge: target.edge }, { icon: 'edit' })]
          : [];
      return [
        ...reason,
        item(
          'Remove Exit',
          { do: 'removeExit', subflow: target.subflow, from: target.from, port: target.port },
          { icon: 'debug-disconnect' },
        ),
      ];
    }
    case 'pane':
      return paneMenu(ctx);
  }
}

// What a right-click on the canvas offers (AFD-18), by target and mode. Pure data: the webview
// renders the entries and runs their actions, so tests can check every menu without React.
// Design and Implementation offer the edits the canvas allows there; Run mode only reads.

import type { Forced } from '../scenario/scenarios';
import { ALIGN_LABEL, type AlignHow, DISTRIBUTE_LABEL, type DistributeHow } from './arrange';
import { formatOf } from './format';
import { type FlowModel, ROOT } from './model';
import type { OpenPort } from './openPorts';
import { nextFrom, type PortMenuItem, portMenu } from './portMenu';
import { portsFor } from './ports';
import { canMarkTested, contentStatus } from './status';
import {
  ANNOTATION_COLORS,
  type AnnotationColor,
  type AnnotationKind,
  NODE_STATUSES,
  type NodeStatus,
  type PortRef,
  type Ulid,
} from './types';

export type CanvasMode = 'design' | 'code' | 'run';

export type CanvasTarget =
  | { kind: 'node'; id: Ulid }
  /** Several nodes, with the annotations picked with them (AFD-65). */
  | { kind: 'nodes'; ids: Ulid[]; annotations?: Ulid[] }
  /** AFD-65: one Note, Section or Text, or several with no node. */
  | { kind: 'annotation'; id: Ulid }
  | { kind: 'annotations'; ids: Ulid[] }
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
  | 'addNote'
  | 'selectAll'
  | 'fit'
  | 'find'
  | 'alignCenter'
  | 'distribute'
  | 'zoomSelection'
  | 'follow';

export type CanvasAction =
  | { do: 'openSubflow'; node: Ulid }
  /** AFD-116: what-if in the scenario being edited: pick the hosts sent down `outcome`. */
  | { do: 'scenarioForce'; step: string; outcome: Forced; title: string }
  | { do: 'scenarioApproval'; approval: string; pick: 'approved' | 'rejected' | 'timeout' }
  | { do: 'scenarioExpect'; host: string; where: string }
  | { do: 'properties'; node: Ulid; tab?: 'binding' }
  | { do: 'rename'; node: Ulid }
  | { do: 'setStatus'; node: Ulid; status: NodeStatus }
  | { do: 'port'; ref: PortRef; item: PortMenuItem }
  | { do: 'addNext'; from: PortRef; insertOn?: Ulid }
  | {
      do: 'cut' | 'copy' | 'duplicate' | 'delete';
      nodes: Ulid[];
      edges?: Ulid[];
      annotations?: Ulid[];
    }
  /** AFD-65: at the menu's spot, or on a node. */
  | { do: 'addAnnotation'; kind: AnnotationKind; on?: Ulid; around?: Ulid[] }
  | { do: 'editAnnotation'; id: Ulid }
  | { do: 'colorAnnotation'; id: Ulid; color: AnnotationColor }
  | { do: 'attachAnnotation'; id: Ulid }
  | { do: 'detachAnnotation'; id: Ulid }
  | { do: 'extract'; nodes: Ulid[] }
  /** AFD-241: the subflow's steps move up to its level; the subflow goes. */
  | { do: 'dissolve'; node: Ulid }
  /** AFD-238: every step the hosts came through to reach this one, or can reach from it. */
  | { do: 'selectFlow'; node: Ulid; dir: 'up' | 'down' }
  | { do: 'zoomSelection' }
  /** AFD-235: out of the path, which closes behind them; the nodes stay. */
  | { do: 'detach'; nodes: Ulid[] }
  /** AFD-88: line steps up or space them evenly (one move); placed steps back to automatic. */
  | { do: 'align'; nodes: Ulid[]; how: AlignHow }
  | { do: 'distribute'; nodes: Ulid[]; how: DistributeHow }
  | { do: 'resetPosition'; nodes: Ulid[] }
  | { do: 'showInText'; node: Ulid }
  | { do: 'peekCode'; node: Ulid }
  | { do: 'find' }
  | { do: 'removeEntry'; subflow: Ulid }
  | { do: 'removeExit'; subflow: Ulid; from: PortRef; port: string }
  | { do: 'editReason'; edge: string }
  /** At the menu's own spot. */
  | { do: 'paste' }
  | { do: 'addNode' }
  /** AFD-60: a subflow of another flow, copied here. */
  | { do: 'insertShared' }
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
  /** The file's format (default: the model's): annotations need 2 (AFD-65). */
  format?: number;
  /** AFD-116: the scenario being edited on the canvas: its what-if items join a step's menu. */
  scenario?: ScenarioMenu;
}

/** What a step's menu needs of the scenario being edited (AFD-116). */
export interface ScenarioMenu {
  name: string;
  hosts: readonly string[];
  /** The key path the scenarios file names a node by. */
  path(node: Ulid): string | undefined;
  /** The hosts forced down an outcome at a step (key path). */
  forced(step: string, outcome: Forced): readonly string[];
  /** The outcome an approval (key path) takes in this scenario. */
  approval(path: string): 'approved' | 'rejected' | 'timeout';
  /** Where the scenario expects each host. */
  expect: Readonly<Record<string, string>>;
}

const FORCE_LABEL: Partial<Record<Forced, string>> = {
  failed: 'Fail for',
  unreachable: 'Unreachable for',
  timeout: 'Time Out for',
  unchanged: 'Unchanged for',
};

/** "In <scenario>": what this step does to which hosts, as the scenario plants it (AFD-116). */
function scenarioItems(model: FlowModel, id: Ulid, s: ScenarioMenu): CanvasMenuEntry[] {
  const node = model.nodes.get(id)?.node;
  const path = s.path(id);
  if (!node || !path) return [];
  const label = (text: string, hosts: readonly string[]) =>
    `${text}…${hosts.length ? ` (${hosts.join(', ')})` : ''}`;
  const ports = new Set(portsFor(node).map((p) => p.name));
  const items: CanvasMenuEntry[] = [];
  const force = (outcome: Forced, text: string, icon: string) => {
    const hosts = s.forced(path, outcome);
    items.push(
      item(
        label(text, hosts),
        { do: 'scenarioForce', step: path, outcome, title: text },
        {
          icon,
          checked: hosts.length > 0,
        },
      ),
    );
  };
  // A subflow with steps is forced through its steps.
  const steps = node.type === 'subflow' && (node.subflow?.nodes?.length ?? 0) > 0;
  if (node.type === 'task' || (node.type === 'subflow' && !steps)) {
    force('failed', FORCE_LABEL.failed as string, 'error');
    for (const o of ['unreachable', 'timeout', 'unchanged'] as const)
      if (ports.has(o)) force(o, FORCE_LABEL[o] as string, 'warning');
  } else if (node.type === 'decision') force('false', 'Take False for', 'git-compare');
  else if (node.type === 'approval') {
    const pick = s.approval(path);
    for (const [p, text] of [
      ['approved', 'Approved'],
      ['rejected', 'Rejected'],
      ['timeout', 'Timed Out'],
    ] as const)
      if (p === 'approved' || ports.has(p))
        items.push(
          item(
            `${text} in This Scenario`,
            { do: 'scenarioApproval', approval: path, pick: p },
            {
              checked: pick === p,
            },
          ),
        );
  } else if (node.type === 'end')
    for (const host of s.hosts)
      items.push(
        item(
          `Expect ${host} Here`,
          { do: 'scenarioExpect', host, where: path },
          {
            checked: s.expect[host] === path,
          },
        ),
      );
  if (items.length === 0) return [];
  return [{ type: 'submenu', label: `In "${s.name}"`, icon: 'beaker', items }];
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

/** A wire joins one of the nodes to a node outside them: there is a path to leave (AFD-235). */
function wired(model: FlowModel, ids: readonly Ulid[]): boolean {
  const set = new Set(ids);
  const level = model.levels.get(model.nodes.get(ids[0] as Ulid)?.level ?? ROOT);
  return (level?.edges ?? []).some((e) => e && set.has(e.from?.node) !== set.has(e.to?.node));
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

  // AFD-238: the steps before and after this one, selected with it.
  const level = model.levels.get(model.nodes.get(id)?.level ?? ROOT);
  const pick: CanvasMenuEntry[] = [];
  if (edit && (level?.edges ?? []).some((e) => e?.to?.node === id))
    pick.push(
      item('Select Upstream', { do: 'selectFlow', node: id, dir: 'up' }, { icon: 'arrow-up' }),
    );
  if (edit && (level?.edges ?? []).some((e) => e?.from?.node === id))
    pick.push(
      item(
        'Select Downstream',
        { do: 'selectFlow', node: id, dir: 'down' },
        { icon: 'arrow-down' },
      ),
    );

  const design: CanvasMenuEntry[] = [];
  if (ctx.mode === 'design')
    design.push(
      item('Rename', { do: 'rename', node: id }, { icon: 'edit', shortcut: 'rename', ...lock }),
    );
  if (edit && !ends && formatOf(model.doc) >= 2) {
    // Format 2 (AFD-50): the status follows the content; tested is the one set by hand.
    if (node.status === 'tested')
      design.push(
        item(
          'Clear Tested',
          { do: 'setStatus', node: id, status: contentStatus(node) },
          { icon: 'circle-large-outline', ...lock },
        ),
      );
    else if (canMarkTested(model.doc, node))
      design.push(
        item(
          'Mark Tested…',
          { do: 'setStatus', node: id, status: 'tested' },
          { icon: 'verified', ...lock },
        ),
      );
  } else if (edit && !ends)
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
  const next = edit ? nextFrom(model, id) : undefined;
  if (next)
    design.push(
      item(
        'Add Next Node…',
        { do: 'addNext', from: { node: id, port: next.port }, insertOn: next.insertOn },
        { icon: 'add', shortcut: 'addNode', ...lock },
      ),
    );
  if (edit && !ends && wired(model, [id]))
    design.push(
      item(
        'Detach from Path',
        { do: 'detach', nodes: [id] },
        { icon: 'debug-disconnect', ...lock },
      ),
    );
  if (edit && node.type === 'subflow') {
    // AFD-241: the reverse of Extract into Subflow.
    const why = node.ref
      ? 'A shared subflow is edited in its source flow'
      : (node.subflow?.nodes ?? []).length === 0
        ? 'The subflow has no steps to move up'
        : undefined;
    design.push(
      item(
        'Dissolve Subflow',
        { do: 'dissolve', node: id },
        { icon: 'ungroup-by-ref-type', ...(why ? { disabled: why } : lock) },
      ),
    );
  }
  if (edit && model.doc.layout?.[id])
    design.push(
      item('Reset Position', { do: 'resetPosition', nodes: [id] }, { icon: 'discard', ...lock }),
    );
  if (edit && formatOf(model.doc) >= 2)
    design.push(
      item(
        'Add Note to This Node',
        { do: 'addAnnotation', kind: 'note', on: id },
        { icon: 'note', shortcut: 'addNote', ...lock },
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
  const what = ctx.scenario ? scenarioItems(model, id, ctx.scenario) : [];
  return groups(what, open, design, pick, clip, code, remove);
}

function groupMenu(
  model: FlowModel,
  ids: Ulid[],
  ctx: CanvasMenuContext,
  annotations: Ulid[] = [],
): CanvasMenuEntry[] {
  const nodes = ids.map((id) => model.nodes.get(id)?.node).filter((n) => !!n);
  const edit = ctx.mode === 'design';
  const lock = ctx.stale ? { disabled: ctx.why ?? STALE } : {};
  const also = annotations.length ? { annotations } : {};
  const clip: CanvasMenuEntry[] = [];
  if (edit)
    clip.push(item('Cut', { do: 'cut', nodes: ids, ...also }, { shortcut: 'cut', ...lock }));
  clip.push(item('Copy', { do: 'copy', nodes: ids, ...also }, { icon: 'copy', shortcut: 'copy' }));
  if (edit)
    clip.push(
      item(
        'Duplicate',
        { do: 'duplicate', nodes: ids, ...also },
        { icon: 'files', shortcut: 'duplicate', ...lock },
      ),
    );
  const more: CanvasMenuEntry[] = [];
  // AFD-68: a Section drawn round the picked nodes (and annotations), so a drag carries them.
  if (edit && formatOf(model.doc) >= 2)
    more.push(
      item(
        'Add Section Around',
        { do: 'addAnnotation', kind: 'section', around: [...ids, ...annotations] },
        { icon: 'layout-panel', ...lock },
      ),
    );
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
  if (edit && wired(model, ids) && !nodes.some((n) => n.type === 'start' || n.type === 'end'))
    more.push(
      item('Detach from Path', { do: 'detach', nodes: ids }, { icon: 'debug-disconnect', ...lock }),
    );
  if (edit && ids.length >= 2) {
    const few = ids.length < 3 ? { disabled: 'Select three steps or more' } : lock;
    const placed = ids.some((id) => model.doc.layout?.[id]);
    more.push({
      type: 'submenu',
      label: 'Arrange',
      icon: 'layout',
      items: [
        ...(['center', 'left', 'right'] as const).map((how) =>
          item(
            ALIGN_LABEL[how],
            { do: 'align', nodes: ids, how },
            { ...(how === 'center' ? { shortcut: 'alignCenter' as const } : {}), ...lock },
          ),
        ),
        { type: 'separator' },
        ...(['top', 'middle', 'bottom'] as const).map((how) =>
          item(ALIGN_LABEL[how], { do: 'align', nodes: ids, how }, lock),
        ),
        { type: 'separator' },
        item(
          DISTRIBUTE_LABEL.vertical,
          { do: 'distribute', nodes: ids, how: 'vertical' },
          { shortcut: 'distribute', ...few },
        ),
        item(DISTRIBUTE_LABEL.horizontal, { do: 'distribute', nodes: ids, how: 'horizontal' }, few),
        ...(placed
          ? [
              { type: 'separator' } as const,
              item('Reset Position', { do: 'resetPosition', nodes: ids }, lock),
            ]
          : []),
      ],
    });
  }
  const remove = edit
    ? [
        item(
          'Delete',
          { do: 'delete', nodes: ids, ...also },
          { icon: 'trash', shortcut: 'delete', ...lock },
        ),
      ]
    : [];
  return groups(clip, more, remove);
}

const COLOR_LABEL: Record<AnnotationColor, string> = {
  yellow: 'Yellow',
  blue: 'Blue',
  green: 'Green',
  pink: 'Pink',
  purple: 'Purple',
  gray: 'Gray',
};

/** AFD-65: a Note, Section or Text: its words, colour, tie, the clipboard and Delete. */
function annotationMenu(model: FlowModel, id: Ulid, ctx: CanvasMenuContext): CanvasMenuEntry[] {
  const a = model.annotations.get(id)?.annotation;
  if (!a) return paneMenu(ctx);
  const kind = a.kind ?? 'note';
  const edit = ctx.mode === 'design';
  const lock = ctx.stale ? { disabled: ctx.why ?? STALE } : {};
  const one = { nodes: [], annotations: [id] };
  const words = edit
    ? [
        item(
          'Edit Text',
          { do: 'editAnnotation', id },
          { icon: 'edit', shortcut: 'rename', ...lock },
        ),
        {
          type: 'submenu' as const,
          label: 'Color',
          icon: 'symbol-color',
          items: ANNOTATION_COLORS.map((color) =>
            item(
              COLOR_LABEL[color],
              { do: 'colorAnnotation', id, color },
              { checked: (a.color ?? (kind === 'note' ? 'yellow' : 'gray')) === color, ...lock },
            ),
          ),
        },
      ]
    : [];
  const tie =
    edit && kind === 'note'
      ? [
          a.on
            ? item(
                'Detach from Node',
                { do: 'detachAnnotation', id },
                { icon: 'debug-disconnect', ...lock },
              )
            : item('Attach to Node…', { do: 'attachAnnotation', id }, { icon: 'link', ...lock }),
        ]
      : [];
  const clip: CanvasMenuEntry[] = [];
  if (edit) clip.push(item('Cut', { do: 'cut', ...one }, { shortcut: 'cut', ...lock }));
  clip.push(item('Copy', { do: 'copy', ...one }, { icon: 'copy', shortcut: 'copy' }));
  if (edit)
    clip.push(
      item(
        'Duplicate',
        { do: 'duplicate', ...one },
        { icon: 'files', shortcut: 'duplicate', ...lock },
      ),
    );
  const remove = edit
    ? [item('Delete', { do: 'delete', ...one }, { icon: 'trash', shortcut: 'delete', ...lock })]
    : [];
  return groups(words, tie, clip, remove);
}

function paneMenu(ctx: CanvasMenuContext): CanvasMenuEntry[] {
  const edit = ctx.mode === 'design';
  const lock = ctx.stale ? { disabled: ctx.why ?? STALE } : {};
  const add = edit
    ? [
        item('Paste Here', { do: 'paste' }, { icon: 'clippy', shortcut: 'paste', ...lock }),
        item('Add Node Here…', { do: 'addNode' }, { icon: 'add', shortcut: 'addNode', ...lock }),
        item('Insert Shared Subflow…', { do: 'insertShared' }, { icon: 'references', ...lock }),
      ]
    : [];
  // AFD-65: annotations are format 2.
  const note =
    edit && (ctx.format ?? 1) >= 2
      ? [
          item(
            'Add Note Here',
            { do: 'addAnnotation', kind: 'note' },
            { icon: 'note', shortcut: 'addNote', ...lock },
          ),
          item(
            'Add Section Here',
            { do: 'addAnnotation', kind: 'section' },
            { icon: 'layout-panel', ...lock },
          ),
          item(
            'Add Text Here',
            { do: 'addAnnotation', kind: 'text' },
            { icon: 'text-size', ...lock },
          ),
        ]
      : [];
  const view: CanvasMenuEntry[] = [
    item('Select All', { do: 'selectAll' }, { icon: 'selection', shortcut: 'selectAll' }),
  ];
  if (edit) view.push(item('Tidy Up', { do: 'tidyUp' }, { icon: 'layout', ...lock }));
  view.push(item('Fit View', { do: 'fitView' }, { icon: 'screen-full', shortcut: 'fit' }));
  view.push(item('Find Node…', { do: 'find' }, { icon: 'search', shortcut: 'find' }));
  const nav =
    ctx.level !== ROOT
      ? [item('Up to Parent', { do: 'upLevel' }, { icon: 'arrow-up', shortcut: 'up' })]
      : [];
  return groups(add, note, view, nav);
}

export function canvasMenu(
  model: FlowModel,
  target: CanvasTarget,
  given: CanvasMenuContext,
): CanvasMenuEntry[] {
  const ctx = { ...given, format: given.format ?? formatOf(model.doc) };
  const edit = ctx.mode === 'design' && !ctx.stale;
  switch (target.kind) {
    case 'node':
      return nodeMenu(model, target.id, ctx);
    case 'nodes':
      return groupMenu(model, target.ids, ctx, target.annotations);
    case 'annotation':
      return annotationMenu(model, target.id, ctx);
    case 'annotations': {
      const lock = ctx.stale ? { disabled: ctx.why ?? STALE } : {};
      const many = { nodes: [], annotations: target.ids };
      if (ctx.mode !== 'design')
        return [item('Copy', { do: 'copy', ...many }, { icon: 'copy', shortcut: 'copy' })];
      return groups(
        [
          item('Cut', { do: 'cut', ...many }, { shortcut: 'cut', ...lock }),
          item('Copy', { do: 'copy', ...many }, { icon: 'copy', shortcut: 'copy' }),
          item(
            'Duplicate',
            { do: 'duplicate', ...many },
            { icon: 'files', shortcut: 'duplicate', ...lock },
          ),
        ],
        [item('Delete', { do: 'delete', ...many }, { icon: 'trash', shortcut: 'delete', ...lock })],
      );
    }
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

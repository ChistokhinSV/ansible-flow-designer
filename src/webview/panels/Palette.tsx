// Left panel in Design mode (04 §1): node palette, failure patterns (D-16) and legend. A node type
// click adds a node near the middle of the view; dragging adds it where it is dropped. A pattern
// is dragged onto an open fail port (or a node), or clicked to resolve the selected node.
// AFD-48: the palette folds to its icons, and the legend opens from a "?" button instead of
// filling the column. AFD-72: the four node types a first flow needs, the rest folded; failure
// patterns once the level has a step that can fail.
import { useReactFlow } from '@xyflow/react';
import { useEffect, useRef, useState } from 'react';
import { formatOf } from '../../core/flow/format';
import { PATTERNS, type PatternId } from '../../core/flow/patterns';
import { isFailPort, portsFor } from '../../core/flow/ports';
import type { AnnotationKind, NodeType } from '../../core/flow/types';
import { LEGEND_PORTS, portHint } from '../../core/view/portHints';
import { addAnnotation } from '../annotationActions';
import { ANNOTATION_MIME, DRAG_MIME, PATTERN_MIME, TYPE_LABEL } from '../constants';
import { useLevelView } from '../hooks';
import { dropPattern } from '../portActions';
import { useUi } from '../store';
import { Fold } from './Fold';
import { HelpLink } from './HelpLink';

const PATTERN_ICON: Partial<Record<PatternId, string>> = {
  rollback: 'discard',
  'notify-stop': 'bell',
  retry: 'refresh',
  exclude: 'circle-slash',
};
const PALETTE_PATTERNS = Object.values(PATTERNS).filter((p) => p.palette);

/** Body class while a pattern is dragged: every node shows its problem ports (styles/). */
const DRAGGING = 'afd-dragging-pattern';

const ITEMS: { type: NodeType; icon: string; hint: string }[] = [
  { type: 'task', icon: 'symbol-event', hint: 'One step: a module, role or playbook' },
  { type: 'subflow', icon: 'type-hierarchy-sub', hint: 'A step with its own inner graph' },
  { type: 'decision', icon: 'git-compare', hint: 'Route each host on a condition' },
  { type: 'approval', icon: 'pass', hint: 'Wait for an approval' },
  { type: 'parallel', icon: 'split-horizontal', hint: 'Send the hosts down several branches' },
  { type: 'join', icon: 'merge', hint: 'Bring branches back together' },
  { type: 'start', icon: 'debug-start', hint: 'Entry point of the flow' },
  { type: 'end', icon: 'debug-stop', hint: 'Exit of the flow' },
];
/** What a first flow needs (AFD-72); the rest sit under More node types. */
const BASIC: ReadonlySet<NodeType> = new Set(['task', 'subflow', 'decision', 'approval']);

/** AFD-65: words on the canvas that explain the flow and never run. */
const NOTES: { kind: AnnotationKind; label: string; icon: string; hint: string }[] = [
  { kind: 'note', label: 'Note', icon: 'note', hint: 'A sticky note; drop it on a node to tie it' },
  {
    kind: 'section',
    label: 'Section',
    icon: 'layout-panel',
    hint: 'A titled region behind steps; moving it moves what is inside',
  },
  { kind: 'text', label: 'Text', icon: 'text-size', hint: 'A heading or caption' },
];

export function Palette() {
  const openQuickAdd = useUi((s) => s.openQuickAdd);
  // Run mode is read-only (AFD-18): the palette shows what exists but adds nothing.
  const locked = useUi((s) => s.mode === 'run');
  const v1 = useUi((s) => !!s.snapshot?.doc && formatOf(s.snapshot.doc) < 2);
  const collapsed = useUi((s) => s.paletteCollapsed);
  const view = useLevelView();
  const canFail = view.nodes.some((n) => portsFor(n.node).some((p) => isFailPort(p.name)));
  const branching = view.nodes.some((n) => n.node.type === 'parallel' || n.node.type === 'join');
  const { screenToFlowPosition } = useReactFlow();
  const addCentered = (type: NodeType) => {
    const canvas = document.querySelector('.react-flow')?.getBoundingClientRect();
    const position = canvas
      ? screenToFlowPosition({
          x: canvas.left + canvas.width / 2,
          y: canvas.top + canvas.height / 3,
        })
      : undefined;
    openQuickAdd({ type, position });
  };
  // Folded, a button is its icon: the name is its label and tooltip.
  const named = (label: string, hint: string) =>
    collapsed ? { 'aria-label': label, title: `${label}: ${hint}` } : { title: hint };
  const nodeItem = (item: (typeof ITEMS)[number]) => (
    <li key={item.type}>
      <button
        type="button"
        draggable={!locked}
        disabled={locked}
        onDragStart={(e) => {
          e.dataTransfer.setData(DRAG_MIME, item.type);
          e.dataTransfer.effectAllowed = 'copy';
        }}
        onClick={() => addCentered(item.type)}
        {...named(TYPE_LABEL[item.type], item.hint)}
      >
        <span className={`codicon codicon-${item.icon}`} aria-hidden="true" />
        {collapsed ? null : TYPE_LABEL[item.type]}
      </button>
    </li>
  );
  const patterns = (
    <>
      {collapsed ? null : (
        <h2>
          Failure patterns <HelpLink topic="patterns" about="failure patterns" />
        </h2>
      )}
      <p
        className={`afd-palette-hint muted${collapsed ? ' afd-sr-only' : ''}`}
        id="afd-pattern-hint"
      >
        Drop onto an open fail port, or select a node and click
      </p>
      <ul className="afd-palette">
        {PALETTE_PATTERNS.map((p) => (
          <li key={p.id}>
            <button
              type="button"
              draggable={!locked}
              disabled={locked}
              data-pattern={p.id}
              // What a pattern needs, read with its name (AFD-47), not only in the tooltip.
              aria-describedby="afd-pattern-hint"
              onDragStart={(e) => {
                e.dataTransfer.setData(PATTERN_MIME, p.id);
                e.dataTransfer.effectAllowed = 'copy';
                document.body.classList.add(DRAGGING);
              }}
              onDragEnd={() => document.body.classList.remove(DRAGGING)}
              onClick={() => {
                const node = useUi.getState().selection.node;
                if (node) void dropPattern(p.id, node);
                else
                  useUi.getState().setError('Select a node first, or drag the pattern onto a port');
              }}
              {...named(p.label, `${p.hint}. Accepts: ${p.accepts.join(', ')}`)}
            >
              <span
                className={`codicon codicon-${PATTERN_ICON[p.id] ?? 'symbol-event'}`}
                aria-hidden="true"
              />
              {collapsed ? null : p.label}
            </button>
          </li>
        ))}
      </ul>
    </>
  );
  return (
    <aside className={`afd-left${collapsed ? ' collapsed' : ''}`} aria-label="Palette">
      <div className="afd-palette-head">
        {collapsed ? null : <h2>Nodes</h2>}
        <button
          type="button"
          className="icon"
          aria-label={collapsed ? 'Expand Palette' : 'Collapse Palette'}
          aria-expanded={!collapsed}
          title={collapsed ? 'Show the names' : 'Icons only, for a wider canvas'}
          onClick={() => useUi.getState().setPaletteCollapsed(!collapsed)}
        >
          <span
            className={`codicon codicon-chevron-${collapsed ? 'right' : 'left'}`}
            aria-hidden="true"
          />
        </button>
      </div>
      {locked ? <p className="afd-palette-hint muted">Run mode is read-only</p> : null}
      {/* Folded to icons, every type shows: there is no room for a fold's summary. */}
      <ul className="afd-palette">
        {ITEMS.filter((i) => collapsed || BASIC.has(i.type)).map(nodeItem)}
      </ul>
      {collapsed ? null : (
        <Fold id="palette-more" open={branching} summary="More node types">
          <ul className="afd-palette">{ITEMS.filter((i) => !BASIC.has(i.type)).map(nodeItem)}</ul>
        </Fold>
      )}
      {canFail ? patterns : null}
      {collapsed ? null : <h2>Annotate</h2>}
      <ul className="afd-palette" aria-label="Annotate">
        {NOTES.map((n) => (
          <li key={n.kind}>
            <button
              type="button"
              draggable={!locked && !v1}
              disabled={locked || v1}
              data-annotation-kind={n.kind}
              onDragStart={(e) => {
                e.dataTransfer.setData(ANNOTATION_MIME, n.kind);
                e.dataTransfer.effectAllowed = 'copy';
              }}
              onClick={() => {
                const canvas = document.querySelector('.react-flow')?.getBoundingClientRect();
                const at = canvas
                  ? screenToFlowPosition({
                      x: canvas.left + canvas.width / 2,
                      y: canvas.top + canvas.height / 2,
                    })
                  : undefined;
                const sel = useUi.getState().selection;
                const on = n.kind === 'note' ? sel.node : undefined;
                // AFD-68: in free space by the middle of the view; a Section wraps what is picked.
                const picked = [
                  ...(sel.nodes ?? (sel.node ? [sel.node] : [])),
                  ...(sel.annotations ?? []),
                ];
                void addAnnotation(n.kind, at, on, {
                  near: true,
                  ...(n.kind === 'section' && picked.length ? { around: picked } : {}),
                });
              }}
              {...named(
                n.label,
                v1 ? 'Annotations need flow format 2: Upgrade Flow Format' : n.hint,
              )}
            >
              <span className={`codicon codicon-${n.icon}`} aria-hidden="true" />
              {collapsed ? null : n.label}
            </button>
          </li>
        ))}
      </ul>
      <Legend collapsed={collapsed} />
    </aside>
  );
}

/** The port and wire styles, on demand: a "?" button and a popover beside the palette. */
function Legend({ collapsed }: { collapsed: boolean }) {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    box.current?.focus();
    const outside = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!box.current?.contains(t) && !button.current?.contains(t)) setOpen(false);
    };
    document.addEventListener('pointerdown', outside, true);
    return () => document.removeEventListener('pointerdown', outside, true);
  }, [open]);
  const close = () => {
    setOpen(false);
    button.current?.focus();
  };
  return (
    <div className="afd-legend-wrap">
      <button
        ref={button}
        type="button"
        className="secondary afd-legend-button"
        aria-expanded={open}
        aria-controls="afd-legend"
        aria-label="Legend"
        title="What the port and wire styles mean"
        onClick={() => (open ? close() : setOpen(true))}
        onKeyDown={(e) => {
          if (e.key !== 'Escape' || !open) return;
          e.stopPropagation();
          close();
        }}
      >
        <span className="codicon codicon-question" aria-hidden="true" />
        {collapsed ? null : ' Legend'}
      </button>
      {open ? (
        <div
          ref={box}
          id="afd-legend"
          className="afd-legend-popover"
          role="dialog"
          aria-label="Legend"
          tabIndex={-1}
          onKeyDown={(e) => {
            if (e.key !== 'Escape') return;
            e.stopPropagation();
            close();
          }}
        >
          <ul className="afd-legend">
            <li>
              <span className="afd-swatch port state-connected tone-ok" /> Connected port
            </li>
            <li>
              <span className="afd-swatch port state-open-fail tone-failed" /> Open fail port (wire
              it or accept it)
            </li>
            <li>
              <span className="afd-swatch port state-open-purpose tone-failed" /> Open on purpose
            </li>
            <li>
              <span className="afd-swatch port state-open tone-ok optional" /> Optional port, shown
              on hover
            </li>
            <li>
              <span className="afd-swatch wire" /> Normal outcome
            </li>
            <li>
              <span className="afd-swatch wire problem" /> Problem path
            </li>
            <li>
              <span className="afd-swatch outside" /> Changed outside the designer (dashed)
            </li>
          </ul>
          {/* AFD-72: the port names stay as in the file; here they are in plain words. */}
          <p className="muted">Hosts travel along wires, from port to port:</p>
          <dl className="afd-legend-ports">
            {LEGEND_PORTS.map((p) => (
              <div key={p}>
                <dt className="mono">{p}</dt>
                <dd>{portHint(p)}</dd>
              </div>
            ))}
          </dl>
        </div>
      ) : null}
    </div>
  );
}

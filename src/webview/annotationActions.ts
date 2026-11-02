// Annotations on the canvas (AFD-65): add one where the menu or the pointer is (a Note on a node
// right of it), recolour, tie and untie. Each is one command. Positions come from what the canvas
// shows, so a Note stays put when it is tied or untied to a node still placed by the canvas.
import { TIE_OFFSET } from '../core/flow/annotations';
import type { AnnotationColor, AnnotationKind, Position, Ulid } from '../core/flow/types';
import { run } from './actions';
import { canvasPlace } from './clipboard';
import { canEdit } from './editActions';
import { useUi } from './store';
import { levelView, unplacedPositions } from './viewModel';

const FIRST_TEXT: Record<AnnotationKind, string> = { note: '', section: 'Section', text: 'Text' };

/** Adds a Note, Section or Text and opens its text for typing. */
export async function addAnnotation(kind: AnnotationKind, at?: Position, on?: Ulid): Promise<void> {
  const ui = useUi.getState();
  if (!canEdit() || !ui.snapshot?.doc) return;
  const view = levelView(ui.snapshot, ui.optimistic, ui.level);
  const place = on ? TIE_OFFSET : (at ?? canvasPlace() ?? { x: 0, y: 0 });
  // A Section drawn around nodes still placed by the canvas keeps them where it was drawn.
  const freeze = kind === 'section' ? unplacedPositions(view, ui.snapshot.doc.layout) : {};
  const ack = await run({
    kind: 'addAnnotation',
    level: ui.level,
    annotation: {
      kind,
      text: FIRST_TEXT[kind],
      x: Math.round(place.x),
      y: Math.round(place.y),
      ...(on ? { on } : {}),
    },
    ...(Object.keys(freeze).length ? { freeze } : {}),
  });
  if (!ack.ok || !ack.created) return;
  useUi.getState().select({ annotations: [ack.created] });
  useUi.getState().editAnnotation(ack.created);
}

export function editAnnotation(id: Ulid): void {
  if (!canEdit()) return;
  useUi.getState().select({ annotations: [id] });
  useUi.getState().editAnnotation(id);
}

export function colorAnnotation(id: Ulid, color: AnnotationColor): void {
  void run({ kind: 'updateAnnotation', id, patch: { color } });
}

/** Where the canvas shows the annotation and a node (absolute positions). */
function shown(id: Ulid, node?: Ulid) {
  const ui = useUi.getState();
  if (!ui.snapshot) return {};
  const view = levelView(ui.snapshot, ui.optimistic, ui.level);
  return {
    at: view.annotations.find((a) => a.annotation.id === id)?.position,
    node: node ? view.nodes.find((n) => n.node.id === node)?.position : undefined,
  };
}

export function detachAnnotation(id: Ulid): void {
  const { at } = shown(id);
  void run({ kind: 'updateAnnotation', id, patch: { on: null, ...(at ?? {}) } });
}

/** Attach to Node…: pick the node with a click or the keyboard (pick mode `attach`). */
export function startAttach(id: Ulid): void {
  useUi.getState().setPick({ mode: 'attach', ref: { node: id, port: '' } });
}

export async function attachAnnotation(id: Ulid, node: Ulid): Promise<void> {
  const { at, node: base } = shown(id, node);
  const rel = at && base ? { x: at.x - base.x, y: at.y - base.y } : TIE_OFFSET;
  await run({ kind: 'updateAnnotation', id, patch: { on: node, x: rel.x, y: rel.y } });
}

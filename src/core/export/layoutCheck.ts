// What makes a level hard to read, in words (AFD-69). The AI tools never see the canvas: they get
// coordinates. So the scene the exports draw (the canvas's own geometry and wires) is checked for
// what a person spots at once: boxes on each other, a wire through a box, a wire label on a box or
// on another label, and wires crossing. Wires step round nodes by themselves (AFD-70), so a wire
// through a node is left only where no route clears it, or through a Note or Text, which wires do
// not avoid. Sections are regions behind nodes, so they are not obstacles.
import { annotationPath, keyPath } from '../ai/refs';
import type { FlowModel } from '../flow/model';
import { openFailPorts } from '../flow/openPorts';
import type { Position } from '../flow/types';
import { exitLabelledAtRest, labelledAtRest } from '../view/nodeFace';
import { type Box, INSET, inset, labelBox, overlaps, pointsOf, segmentHits } from '../view/route';
import { type ExportSource, type Scene, scenesOf } from './scene';

export type LayoutProblemKind = 'overlap' | 'through' | 'label' | 'labels' | 'cross';

export interface LayoutProblem {
  kind: LayoutProblemKind;
  text: string;
}

interface Thing {
  id: string;
  name: string;
  box: Box;
}

interface Line {
  name: string;
  from: string;
  to: string;
  points: Position[];
  label?: { text: string; box: Box };
}

/** Crossings listed per level; the rest are counted. */
const MAX_CROSSINGS = 8;
const ORDER: LayoutProblemKind[] = ['overlap', 'through', 'label', 'labels', 'cross'];

const flat = (a: number, b: number) => Math.abs(a - b) < 0.5;
/** Strictly inside the span, by more than a pixel: touching ends and corners are not crossings. */
const within = (v: number, p: number, q: number) =>
  v > Math.min(p, q) + 1 && v < Math.max(p, q) - 1;

/** Whether two wire segments cross at a right angle (wires only run straight across). */
function segmentsCross(a1: Position, a2: Position, b1: Position, b2: Position): boolean {
  if (flat(a1.y, a2.y) && flat(b1.x, b2.x))
    return within(b1.x, a1.x, a2.x) && within(a1.y, b1.y, b2.y);
  if (flat(a1.x, a2.x) && flat(b1.y, b2.y)) return segmentsCross(b1, b2, a1, a2);
  return false;
}

function linesCross(a: Line, b: Line): boolean {
  for (let i = 0; i + 1 < a.points.length; i++)
    for (let j = 0; j + 1 < b.points.length; j++)
      if (
        segmentsCross(
          a.points[i] as Position,
          a.points[i + 1] as Position,
          b.points[j] as Position,
          b.points[j + 1] as Position,
        )
      )
        return true;
  return false;
}

const short = (s: string) => (s.length > 32 ? `${s.slice(0, 31)}…` : s);

/** Boxes and wires of a scene, named by key path as flow_describe names them. */
function partsOf(scene: Scene, model: FlowModel): { things: Thing[]; lines: Line[] } {
  const things: Thing[] = [
    ...scene.view.nodes.map((n) => ({
      id: n.node.id,
      name: keyPath(model, n.node.id),
      box: { ...n.position, width: n.width, height: n.height },
    })),
    ...scene.view.annotations
      .filter((a) => a.kind !== 'section')
      .map((a) => ({
        id: a.annotation.id,
        name: annotationPath(model, a.annotation.id),
        box: { ...a.position, width: a.width, height: a.height },
      })),
  ];
  const lines: Line[] = [];
  const add = (id: string, name: string, from: string, to: string, label?: string) => {
    const w = scene.wires.get(id);
    if (!w) return;
    lines.push({
      name,
      from,
      to,
      points: pointsOf(w.path),
      ...(label ? { label: { text: label, box: labelBox(label, w.label) } } : {}),
    });
  };
  for (const e of scene.view.edges) {
    const target = `${keyPath(model, e.target)}${e.targetPort === 'in' ? '' : `.${e.targetPort}`}`;
    add(
      e.id,
      `${keyPath(model, e.source)}.${e.sourcePort} -> ${target}`,
      `${e.source}.${e.sourcePort}`,
      `${e.target}.${e.targetPort}`,
      labelledAtRest(e.sourcePort) ? e.sourcePort : undefined,
    );
  }
  for (const e of scene.boundary?.edges ?? []) {
    if (e.kind === 'entry')
      add(e.id, `entry -> ${keyPath(model, e.target)}`, 'entry', `${e.target}.in`);
    else
      add(
        e.id,
        `${keyPath(model, e.source)}.${e.sourcePort} -> exit ${e.targetPort}`,
        `${e.source}.${e.sourcePort}`,
        `exit.${e.targetPort}`,
        exitLabelledAtRest(e) ? e.label : undefined,
      );
  }
  return { things, lines };
}

/** The layout problems of one level, worst first. */
export function layoutProblems(scene: Scene, model: FlowModel): LayoutProblem[] {
  const { things, lines } = partsOf(scene, model);
  const out: LayoutProblem[] = [];
  const at = (t: Thing) => `${t.name} at ${Math.round(t.box.x)},${Math.round(t.box.y)}`;
  for (let i = 0; i < things.length; i++)
    for (let j = i + 1; j < things.length; j++) {
      const [a, b] = [things[i] as Thing, things[j] as Thing];
      if (overlaps(a.box, b.box))
        out.push({ kind: 'overlap', text: `${at(a)} overlaps ${b.name}` });
    }
  for (const l of lines) {
    const hit = things.filter((t) => {
      const r = inset(t.box, INSET);
      return l.points.some((p, i) => {
        const q = l.points[i + 1];
        return q !== undefined && segmentHits(p, q, r);
      });
    });
    if (hit.length)
      out.push({
        kind: 'through',
        text: `wire ${l.name} runs through ${hit.map((t) => t.name).join(', ')}`,
      });
    if (!l.label) continue;
    const under = things.filter((t) => overlaps(l.label?.box as Box, t.box));
    if (under.length)
      out.push({
        kind: 'label',
        text: `label "${short(l.label.text)}" of wire ${l.name} covers ${under.map((t) => t.name).join(', ')}`,
      });
  }
  const labelled = lines.filter((l) => l.label);
  for (let i = 0; i < labelled.length; i++)
    for (let j = i + 1; j < labelled.length; j++) {
      const [a, b] = [labelled[i] as Line, labelled[j] as Line];
      if (overlaps(a.label?.box as Box, b.label?.box as Box))
        out.push({ kind: 'labels', text: `labels of wires ${a.name} and ${b.name} overlap` });
    }
  const crossings: string[] = [];
  for (let i = 0; i < lines.length; i++)
    for (let j = i + 1; j < lines.length; j++) {
      const [a, b] = [lines[i] as Line, lines[j] as Line];
      // Wires out of one port or into one port share their first or last stretch on purpose.
      if (a.from === b.from || a.to === b.to) continue;
      if (linesCross(a, b)) crossings.push(`wires ${a.name} and ${b.name} cross`);
    }
  out.push(...crossings.slice(0, MAX_CROSSINGS).map((text) => ({ kind: 'cross' as const, text })));
  if (crossings.length > MAX_CROSSINGS)
    out.push({ kind: 'cross', text: `and ${crossings.length - MAX_CROSSINGS} more crossing(s)` });
  return out.sort((a, b) => ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind));
}

/** How to act on the problems, for the AI tools. */
export const LAYOUT_FIX =
  'Fix wires through boxes and labels on boxes first. Wires step round nodes where a gap lets them, so a wire still through a box needs room: move the box in the way beside the wire (move, right_of or left_of), or move a note or text off it; crossings matter less and are fine when no move removes them. Check again with flow_describe layout: true.';

/** The problems of every level, or of the levels named, where the canvas shows the nodes. */
export function flowLayoutProblems(
  model: FlowModel,
  shown: ExportSource['shown'],
  only?: ReadonlySet<string>,
): Map<string, LayoutProblem[]> {
  const src: ExportSource = {
    doc: { ...model.doc, layout: shown.stored },
    shown,
    // Problems and open ports colour wires; they never move them.
    findings: [],
    openPorts: openFailPorts(model),
  };
  const out = new Map<string, LayoutProblem[]>();
  for (const scene of scenesOf(src))
    if (!only || only.has(scene.level)) out.set(scene.level, layoutProblems(scene, model));
  return out;
}

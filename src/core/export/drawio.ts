// draw.io file of a flow (AFD-25): one page per level, top first, in drill-down order. Nodes keep
// the canvas look (status fills, dashed drafts, double subflows, pills) and carry their details as
// shape data; ports at rest are small child shapes the wires attach to, so moving a node in draw.io
// keeps its wires. A subflow node links to its page and each subflow page links back to its parent.

import { portAccepted } from '../flow/decisions';
import { keywordHint } from '../flow/keywords';
import type { FramePortView, PortView } from '../flow/levelView';
import { buildModel, ROOT } from '../flow/model';
import type { PortTone } from '../flow/ports';
import type { FlowNode } from '../flow/types';
import { FILLS, TONES } from '../theme';
import { type Detail, flowDetails, NODE_TYPE_LABEL, nodeDetails, tooltipOf } from './details';
import { type ExportSource, type Scene, scenesOf } from './scene';

const TONE = TONES.light;
const FILL = FILLS.light;
export const INK = { bg: '#ffffff', fg: '#1f2328', muted: '#6b7280', frame: '#f8f8f9' };

/** XML attribute value; newlines kept as character references (draw.io shows them). */
export const attr = (s: string) =>
  s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll('\n', '&#10;');
const html = (s: string) =>
  s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const style = (parts: Record<string, string | number | undefined>) =>
  Object.entries(parts)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}=${v}`)
    .join(';');

export const toneColour = (tone: PortTone) => (tone === 'neutral' ? TONE.neutral : TONE[tone]);

/** Fill, border and line of a node as the canvas CSS draws it (styles/07-nodes.css `.afd-node`). */
export function nodeLook(node: FlowNode) {
  let fill = INK.bg;
  let stroke = TONE.neutral;
  let width = 1.5;
  let dashed = (node.status ?? 'draft') === 'draft';
  if (node.status === 'specified') [fill, stroke] = [FILL['fill-specified'], TONE.approval];
  if (node.status === 'implemented') [fill, stroke] = [FILL['fill-implemented'], TONE.ok];
  if (node.status === 'tested') [fill, stroke, width] = [FILL['fill-tested'], TONE.ok, 2];
  if (node.type === 'subflow') dashed = false;
  if (node.type === 'decision') [fill, stroke] = [FILL['fill-decision'], TONE.decision];
  if (node.type === 'approval') [fill, stroke] = [FILL['fill-approval'], TONE.approval];
  if (node.handler) [fill, stroke] = [FILL['fill-handler'], TONE.unreachable];
  const pill = node.type === 'start' || node.type === 'end';
  if (pill) dashed = false;
  if (node.type === 'end' && node.outcome === 'failed')
    [fill, stroke] = [FILL['fill-failed-end'], TONE.failed];
  const status = node.status ?? 'draft';
  const dot = status === 'specified' ? TONE.approval : status === 'draft' ? undefined : TONE.ok;
  const sub = [NODE_TYPE_LABEL[node.type], status, node.handler, keywordHint(node.impl)]
    .filter(Boolean)
    .join(' · ');
  return { fill, stroke, width, dashed, pill, double: node.type === 'subflow', dot, sub };
}

/** Square of a port at rest (D-13): filled when wired, amber when open, dashed when open on purpose. */
export function portLook(p: Pick<PortView, 'tone' | 'state' | 'optional'>) {
  let stroke = toneColour(p.tone);
  let fill = INK.bg;
  let width = 2;
  let dash: string | undefined;
  if (p.state === 'connected') fill = stroke;
  if (p.state === 'open-fail') [stroke, width] = [TONE.unreachable, 2.5];
  if (p.state === 'open-purpose') [stroke, dash] = [TONE.neutral, '3 2'];
  if (p.optional && p.state !== 'connected') dash = '1 2';
  return { fill, stroke, width, dash };
}

function nodeLabel(node: FlowNode): string {
  const look = nodeLook(node);
  if (look.pill) return `<b>${html(node.title)}</b>`;
  const dot = look.dot
    ? `<font color="${look.dot}">&#9679;</font>`
    : `<font color="${TONE.neutral}">&#9675;</font>`;
  const chip = node.impl?.ref
    ? `<br><font face="Courier New" style="font-size:10px" color="${INK.muted}">${html(node.impl.ref)}</font>`
    : '';
  return `${dot}&nbsp;<b>${html(node.title)}</b><br><font style="font-size:11px" color="${INK.muted}">${html(look.sub)}</font>${chip}`;
}

function nodeStyle(node: FlowNode): string {
  const look = nodeLook(node);
  return style({
    ...(look.double ? { shape: 'ext', double: 1 } : {}),
    rounded: 1,
    ...(look.pill ? { arcSize: 50 } : { absoluteArcSize: 1, arcSize: 12 }),
    whiteSpace: 'wrap',
    html: 1,
    overflow: 'hidden',
    align: look.pill ? 'center' : 'left',
    verticalAlign: 'middle',
    spacingLeft: look.pill ? undefined : 10,
    spacingRight: look.pill ? undefined : 8,
    fontFamily: 'Helvetica',
    fontSize: 12,
    fontColor: INK.fg,
    fillColor: look.fill,
    strokeColor: look.stroke,
    strokeWidth: look.width,
    ...(look.dashed ? { dashed: 1, dashPattern: '4 3' } : {}),
  });
}

/** Relative spot of a port on its parent's edge (draw.io relative geometry). */
const SPOT: Record<string, (o: number) => [number, number]> = {
  top: (o) => [o, 0],
  bottom: (o) => [o, 1],
  left: (o) => [0, o],
  right: (o) => [1, o],
};
/** Where a wire leaves or enters a port shape, by the side the port faces. */
const FACE: Record<string, [number, number]> = {
  top: [0.5, 0],
  bottom: [0.5, 1],
  left: [0, 0.5],
  right: [1, 0.5],
};
const LABEL_AT: Record<string, Record<string, string>> = {
  right: {
    labelPosition: 'right',
    align: 'left',
    verticalLabelPosition: 'middle',
    verticalAlign: 'middle',
  },
  left: {
    labelPosition: 'left',
    align: 'right',
    verticalLabelPosition: 'middle',
    verticalAlign: 'middle',
  },
  bottom: {
    labelPosition: 'center',
    align: 'center',
    verticalLabelPosition: 'bottom',
    verticalAlign: 'top',
  },
  top: {
    labelPosition: 'center',
    align: 'center',
    verticalLabelPosition: 'top',
    verticalAlign: 'bottom',
  },
};

const STATE_TEXT: Record<string, string> = {
  connected: 'connected',
  'open-fail': 'open: not handled',
  'open-purpose': 'open on purpose',
  open: 'open',
  available: 'optional, not enabled',
  bubbled: 'fed by inner fail ports that bubble up',
  unfed: 'no inner step leads here',
};

interface Out {
  cells: string[];
}

function userObject(
  out: Out,
  id: string,
  label: string,
  data: readonly Detail[],
  extra: Record<string, string>,
  cell: string,
): void {
  const attrs = [
    `id="${attr(id)}"`,
    `label="${attr(label)}"`,
    ...Object.entries(extra).map(([k, v]) => `${k}="${attr(v)}"`),
    ...data.map(([k, v]) => `${k}="${attr(v)}"`),
  ];
  out.cells.push(`<UserObject ${attrs.join(' ')}>${cell}</UserObject>`);
}

function portCell(
  out: Out,
  parent: string,
  p: { name: string; side: string; offset: number },
  look: ReturnType<typeof portLook>,
  size: number,
  state: string,
  reason: string | undefined,
  labelled: boolean,
): string {
  const id = `${parent}:${p.name}`;
  const [rx, ry] = (SPOT[p.side] ?? SPOT.bottom)?.(p.offset) ?? [0.5, 1];
  const s = style({
    rounded: 0,
    html: 1,
    movable: 0,
    resizable: 0,
    rotatable: 0,
    deletable: 0,
    editable: 0,
    connectable: 1,
    fillColor: look.fill,
    strokeColor: look.stroke,
    strokeWidth: look.width,
    ...(look.dash ? { dashed: 1, dashPattern: look.dash } : {}),
    ...(labelled ? { ...LABEL_AT[p.side], fontSize: 9, fontColor: look.stroke, spacing: 2 } : {}),
  });
  const data: Detail[] = [
    ['port', p.name],
    ['state', STATE_TEXT[state] ?? state],
  ];
  if (reason) data.push(['reason', reason]);
  userObject(
    out,
    id,
    labelled ? p.name : '',
    data,
    { tooltip: `${p.name}: ${STATE_TEXT[state] ?? state}${reason ? ` (${reason})` : ''}` },
    `<mxCell style="${attr(s)}" vertex="1" parent="${attr(parent)}"><mxGeometry x="${rx}" y="${ry}" width="${size}" height="${size}" relative="1" as="geometry"><mxPoint x="${-size / 2}" y="${-size / 2}" as="offset"/></mxGeometry></mxCell>`,
  );
  return id;
}

function edgeCell(
  out: Out,
  id: string,
  label: string,
  data: Detail[],
  from: { id: string; side: string },
  to: { id: string; side: string },
  tone: PortTone,
  problem: boolean,
): void {
  const [ex, ey] = FACE[from.side] ?? [0.5, 1];
  const [nx, ny] = FACE[to.side] ?? [0.5, 0];
  const colour = toneColour(tone);
  const s = style({
    edgeStyle: 'orthogonalEdgeStyle',
    rounded: 1,
    orthogonalLoop: 1,
    jettySize: 'auto',
    html: 1,
    endArrow: 'block',
    endFill: 1,
    endSize: 5,
    strokeColor: colour,
    strokeWidth: 1.6,
    ...(problem ? { dashed: 1, dashPattern: '5 4' } : {}),
    fontFamily: 'Courier New',
    fontSize: 10,
    fontColor: INK.muted,
    labelBackgroundColor: INK.bg,
    exitX: ex,
    exitY: ey,
    exitDx: 0,
    exitDy: 0,
    entryX: nx,
    entryY: ny,
    entryDx: 0,
    entryDy: 0,
  });
  userObject(
    out,
    id,
    label,
    data,
    {},
    `<mxCell style="${attr(s)}" edge="1" parent="1" source="${attr(from.id)}" target="${attr(to.id)}"><mxGeometry relative="1" as="geometry"/></mxCell>`,
  );
}

/** Page ID of a level. */
export const pageId = (level: string) => `afd-${level}`;

/** Offset that puts a scene's drawing below its title block, from (40, 120). */
export function shiftOf(scene: Scene): { dx: number; dy: number } {
  return { dx: Math.round(40 - scene.bounds.x), dy: Math.round(120 - scene.bounds.y) };
}

function page(src: ExportSource, scene: Scene, byLevel: Map<string, Scene>): string {
  const model = buildModel(src.doc);
  const out: Out = { cells: [] };
  const { dx, dy } = shiftOf(scene);
  const flow = src.doc.flow;
  // The flow's own data sits on the root cell: Edit Data with nothing selected shows it.
  userObject(out, '0', '', flowDetails(src.doc, src.findings), {}, '<mxCell/>');
  out.cells.push('<mxCell id="1" parent="0"/>');

  // Title block, linking back to the parent level on subflow pages.
  const parent = scene.parent !== undefined ? byLevel.get(scene.parent) : undefined;
  const where = scene.level === ROOT ? 'Top level' : `Subflow ${scene.path}: ${scene.title}`;
  const back = parent
    ? `<br><font color="${TONE.accent}">&#8593; back to ${html(parent.level === ROOT ? 'the top level' : parent.title)}</font>`
    : '';
  const goal = flow.goal ? `<br><font color="${INK.muted}"><i>${html(flow.goal)}</i></font>` : '';
  userObject(
    out,
    'afd-title',
    `<font style="font-size:15px"><b>${html(flow.name)}</b></font> &middot; v${flow.version}<br>${html(where)}${goal}${back}`,
    [['level', scene.path || 'top']],
    parent ? { link: `data:page/id,${pageId(parent.level)}` } : {},
    `<mxCell style="${attr(style({ strokeColor: 'none', fillColor: 'none', html: 1, align: 'left', verticalAlign: 'top', whiteSpace: 'wrap', fontFamily: 'Helvetica', fontSize: 12, fontColor: INK.fg, spacing: 0 }))}" vertex="1" parent="1"><mxGeometry x="40" y="20" width="${Math.max(420, Math.round(scene.bounds.width))}" height="80" as="geometry"/></mxCell>`,
  );

  // The subflow's boundary frame, behind its steps.
  const frameId = 'afd-frame';
  if (scene.boundary) {
    const f = scene.boundary.frame;
    userObject(
      out,
      frameId,
      `Subflow boundary &middot; ${html(scene.boundary.subflow.title)}`,
      [['subflow', scene.path]],
      parent ? { link: `data:page/id,${pageId(parent.level)}` } : {},
      `<mxCell style="${attr(style({ rounded: 1, absoluteArcSize: 1, arcSize: 20, dashed: 1, dashPattern: '6 4', fillColor: INK.frame, strokeColor: TONE.neutral, strokeWidth: 2, html: 1, whiteSpace: 'wrap', align: 'left', verticalAlign: 'top', spacingLeft: 10, spacingTop: 2, fontFamily: 'Helvetica', fontSize: 11, fontColor: INK.muted }))}" vertex="1" parent="1"><mxGeometry x="${f.x + dx}" y="${f.y + dy}" width="${f.width}" height="${f.height}" as="geometry"/></mxCell>`,
    );
    for (const p of scene.boundary.ports) {
      if (p.state === 'available') continue;
      portCell(out, frameId, p, frameLook(p), 12, p.state, undefined, true);
    }
  }

  // Nodes with their resting ports.
  const ports = new Map<string, { id: string; side: string }>();
  for (const v of scene.view.nodes) {
    const n = v.node;
    const details = nodeDetails(n, { model, findings: src.findings, openPorts: src.openPorts });
    const inner = byLevel.get(n.id);
    userObject(
      out,
      n.id,
      nodeLabel(n),
      details,
      {
        tooltip: tooltipOf(n, details),
        ...(inner ? { link: `data:page/id,${pageId(inner.level)}` } : {}),
      },
      `<mxCell style="${attr(nodeStyle(n))}" vertex="1" parent="1"><mxGeometry x="${v.position.x + dx}" y="${v.position.y + dy}" width="${v.width}" height="${v.height}" as="geometry"/></mxCell>`,
    );
    for (const p of v.ports) {
      if (!p.rest) continue;
      const reason =
        p.state === 'open-purpose' ? portAccepted(src.doc, n.id, p.name)?.reason : undefined;
      const id = portCell(out, n.id, p, portLook(p), 10, p.state, reason, p.state !== 'connected');
      ports.set(id, { id, side: p.side });
    }
  }

  // Wires: labelled with their port, as on the canvas.
  const keyOf = (id: string) => scene.view.nodes.find((v) => v.node.id === id)?.node.key ?? id;
  for (const e of scene.view.edges) {
    const from = ports.get(`${e.source}:${e.sourcePort}`);
    const to = ports.get(`${e.target}:${e.targetPort}`);
    if (!from || !to) continue;
    edgeCell(
      out,
      e.id,
      e.sourcePort,
      [
        ['port', e.sourcePort],
        ['from', keyOf(e.source)],
        ['to', keyOf(e.target)],
      ],
      from,
      to,
      e.tone,
      e.problem,
    );
  }
  for (const e of scene.boundary?.edges ?? []) {
    const side = (name: string) =>
      scene.boundary?.ports.find((p) => p.name === name)?.side ?? 'top';
    const facing: Record<string, string> = { top: 'bottom', bottom: 'top', right: 'left' };
    if (e.kind === 'entry') {
      const to = ports.get(`${e.target}:${e.targetPort}`);
      if (!to) continue;
      edgeCell(
        out,
        e.id,
        e.label,
        [['entry', keyOf(e.target)]],
        { id: `${frameId}:in`, side: 'bottom' },
        to,
        e.tone,
        false,
      );
    } else {
      const from = ports.get(`${e.source}:${e.sourcePort}`);
      if (!from) continue;
      const exit: Detail[] = [
        ['exit', e.targetPort],
        ['from', `${keyOf(e.source)}.${e.sourcePort}`],
      ];
      if (e.exit?.reason) exit.push(['reason', e.exit.reason]);
      edgeCell(
        out,
        e.id,
        e.label,
        exit,
        from,
        { id: `${frameId}:${e.targetPort}`, side: facing[side(e.targetPort)] ?? 'top' },
        e.tone,
        e.problem,
      );
    }
  }

  const name = scene.level === ROOT ? flow.name : `${scene.title} (${scene.path})`;
  return `<diagram id="${attr(pageId(scene.level))}" name="${attr(name)}"><mxGraphModel dx="0" dy="0" grid="1" gridSize="10" guides="1" tooltips="1" connect="1" arrows="1" fold="1" page="0" pageScale="1" math="0" shadow="0" background="${INK.bg}"><root>${out.cells.join('')}</root></mxGraphModel></diagram>`;
}

/** Frame ports (D-23): filled when an inner step leaves through them, half when fail ports bubble. */
function frameLook(p: FramePortView) {
  const tone = toneColour(p.tone);
  if (p.state === 'connected') return { fill: tone, stroke: tone, width: 2, dash: undefined };
  if (p.state === 'bubbled') return { fill: TONE.failed, stroke: tone, width: 2, dash: '2 2' };
  return { fill: INK.bg, stroke: TONE.unreachable, width: 2.5, dash: undefined };
}

/**
 * The flow as a draw.io file (uncompressed XML). `first` puts that level's page first, for images
 * that embed the diagram: draw.io opens the first page.
 */
export function toDrawio(src: ExportSource, opts: { first?: string; agent?: string } = {}): string {
  const scenes = scenesOf(src);
  const byLevel = new Map(scenes.map((s) => [s.level, s]));
  const ordered = opts.first
    ? [
        ...scenes.filter((s) => s.level === opts.first),
        ...scenes.filter((s) => s.level !== opts.first),
      ]
    : scenes;
  const pages = ordered.map((s) => page(src, s, byLevel));
  return `<mxfile host="Ansible Flow Designer" agent="${attr(opts.agent ?? 'Ansible Flow Designer')}" pages="${pages.length}">${pages.join('')}</mxfile>\n`;
}

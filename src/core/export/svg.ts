// SVG image of one flow level (AFD-25), drawn like the canvas in its light theme: node boxes with
// status dot, title, type line and binding chip; resting ports; wires (smooth steps, or routed round
// nodes: AFD-70) coloured by port
// with their port name; a subflow's boundary frame. `content` embeds the draw.io file, as draw.io's
// own `.drawio.svg` does, so draw.io opens the image as an editable diagram.

import type { AnnotationView } from '../flow/annotations';
import type { FramePortView, NodeView, PortView } from '../flow/levelView';
import { ROOT } from '../flow/model';
import type { PortTone } from '../flow/ports';
import { NOTE_COLORS, TONES } from '../theme';
import { plainText } from '../view/markdown';
import { tieLine } from '../view/tie';
import { attr, INK, nodeLook, portLook, shiftOf, toneColour } from './drawio';
import { type ExportSource, portCentre, type Scene, scenesOf } from './scene';
import { fitText, textWidth, wrapText } from './text';
import { xmlClean } from './xml';

const TONE = TONES.light;
const CHIP_BORDER = '#d3d3d3';
const FONT = 'Arial, Helvetica, sans-serif';
const MONO = 'Consolas, "Courier New", monospace';
const TONE_NAMES: PortTone[] = [
  'ok',
  'failed',
  'unreachable',
  'decision',
  'approval',
  'undo',
  'neutral',
];

const esc = (s: unknown) =>
  xmlClean(s)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
const n2 = (v: number) => Math.round(v * 100) / 100;

function text(x: number, y: number, s: string, a: Record<string, string | number> = {}): string {
  const extra = Object.entries(a)
    .map(([k, v]) => ` ${k}="${typeof v === 'number' ? n2(v) : esc(v)}"`)
    .join('');
  return `<text x="${n2(x)}" y="${n2(y)}"${extra}>${esc(s)}</text>`;
}

/** React Flow's closed arrow (MarkerType.ArrowClosed), one per wire colour. */
function markers(): string {
  return TONE_NAMES.map(
    (t) =>
      `<marker id="afd-arrow-${t}" viewBox="-10 -10 20 20" refX="0" refY="0" markerWidth="12.5" markerHeight="12.5" markerUnits="strokeWidth" orient="auto-start-reverse"><polyline points="-5,-4 0,0 -5,4 -5,-4" fill="${toneColour(t)}" stroke="${toneColour(t)}" stroke-width="1" stroke-linecap="round" stroke-linejoin="round"/></marker>`,
  ).join('');
}

function square(
  cx: number,
  cy: number,
  size: number,
  look: { fill: string; stroke: string; width: number; dash?: string },
): string {
  const dash = look.dash ? ` stroke-dasharray="${look.dash}"` : '';
  return `<rect x="${n2(cx - size / 2)}" y="${n2(cy - size / 2)}" width="${size}" height="${size}" rx="1" fill="${look.fill}" stroke="${look.stroke}" stroke-width="${look.width}"${dash}/>`;
}

/** A port name next to its square, outside the box (open ports have no wire to name them). */
function portName(cx: number, cy: number, side: string, name: string, colour: string): string {
  const a = { 'font-size': 9, fill: colour, 'font-family': MONO };
  if (side === 'right') return text(cx + 9, cy + 3, name, a);
  if (side === 'left') return text(cx - 9, cy + 3, name, { ...a, 'text-anchor': 'end' });
  if (side === 'top') return text(cx, cy - 9, name, { ...a, 'text-anchor': 'middle' });
  return text(cx, cy + 16, name, { ...a, 'text-anchor': 'middle' });
}

function nodeSvg(v: NodeView): string {
  const n = v.node;
  const look = nodeLook(n);
  const { x, y } = v.position;
  const { width: w, height: h } = v;
  const out: string[] = [];
  const dash = look.dashed ? ' stroke-dasharray="4 3"' : '';
  const rx = look.pill ? h / 2 : 6;
  if (look.double) {
    // CSS `border: 4px double`: two thin lines with a gap.
    out.push(
      `<rect x="${n2(x + 0.65)}" y="${n2(y + 0.65)}" width="${n2(w - 1.3)}" height="${n2(h - 1.3)}" rx="${rx}" fill="${look.fill}" stroke="${look.stroke}" stroke-width="1.3"/>`,
      `<rect x="${n2(x + 3.35)}" y="${n2(y + 3.35)}" width="${n2(w - 6.7)}" height="${n2(h - 6.7)}" rx="${rx - 2}" fill="none" stroke="${look.stroke}" stroke-width="1.3"/>`,
    );
  } else {
    const i = look.width / 2;
    out.push(
      `<rect x="${n2(x + i)}" y="${n2(y + i)}" width="${n2(w - 2 * i)}" height="${n2(h - 2 * i)}" rx="${rx}" fill="${look.fill}" stroke="${look.stroke}" stroke-width="${look.width}"${dash}/>`,
    );
  }
  if (look.pill) {
    out.push(
      text(x + w / 2, y + h / 2 + 4.4, fitText(n.title, w - 24, 12.5, { bold: true }), {
        'font-size': 12.5,
        'font-weight': 600,
        fill: INK.fg,
        'text-anchor': 'middle',
      }),
    );
    return out.join('');
  }
  // The body: head (dot + title), type line, binding chip, centred as a flex column with 2 px gaps.
  const chip = n.impl?.ref;
  const rows = [15, 13.2, ...(chip ? [15] : [])];
  let top = y + (h - (rows.reduce((a, b) => a + b, 0) + 2 * (rows.length - 1))) / 2;
  const left = x + 10;
  const inner = w - 20;
  const mid = top + 7.5;
  out.push(
    look.dot
      ? `<circle cx="${n2(left + 4)}" cy="${n2(mid)}" r="3.25" fill="${look.dot}" stroke="${look.dot}" stroke-width="1.5"/>`
      : `<circle cx="${n2(left + 4)}" cy="${n2(mid)}" r="3.25" fill="none" stroke="${TONE.neutral}" stroke-width="1.5"/>`,
    text(left + 14, mid + 4.4, fitText(n.title, inner - 14, 12.5, { bold: true }), {
      'font-size': 12.5,
      'font-weight': 600,
      fill: INK.fg,
    }),
  );
  top += 15 + 2;
  out.push(
    text(left, top + 10.4, fitText(look.sub, inner, 11), { 'font-size': 11, fill: INK.muted }),
  );
  top += 13.2 + 2;
  if (chip) {
    const label = fitText(chip, inner - 12, 11, { mono: true });
    const cw = Math.min(inner, textWidth(label, 11, { mono: true }) + 12);
    out.push(
      `<rect x="${n2(left)}" y="${n2(top)}" width="${n2(cw)}" height="15" rx="7.5" fill="none" stroke="${CHIP_BORDER}" stroke-width="1"/>`,
      text(left + 6, top + 11.2, label, { 'font-size': 11, fill: INK.muted, 'font-family': MONO }),
    );
  }
  return out.join('');
}

function portsSvg(v: NodeView): string {
  const box = { ...v.position, width: v.width, height: v.height };
  return v.ports
    .filter((p: PortView) => p.rest)
    .map((p) => {
      const c = portCentre(box, p.side, p.offset);
      const look = portLook(p);
      const halo =
        p.state === 'open-fail'
          ? `<rect x="${n2(c.x - 7.5)}" y="${n2(c.y - 7.5)}" width="15" height="15" rx="2" fill="none" stroke="${TONE.unreachable}" stroke-opacity="0.3" stroke-width="2"/>`
          : '';
      const name = p.state === 'connected' ? '' : portName(c.x, c.y, p.side, p.name, look.stroke);
      return halo + square(c.x, c.y, 10, look) + name;
    })
    .join('');
}

function frameSvg(scene: Scene): string {
  const b = scene.boundary;
  if (!b) return '';
  const f = b.frame;
  const out = [
    `<rect x="${n2(f.x + 1)}" y="${n2(f.y + 1)}" width="${n2(f.width - 2)}" height="${n2(f.height - 2)}" rx="10" fill="${INK.frame}" stroke="${TONE.neutral}" stroke-width="2" stroke-dasharray="6 4"/>`,
    text(f.x + 10, f.y + 17, `Subflow boundary · ${b.subflow.title}`, {
      'font-size': 11,
      fill: INK.muted,
    }),
  ];
  for (const p of b.ports as FramePortView[]) {
    if (p.state === 'available') continue;
    const c = portCentre(f, p.side, p.offset);
    const tone = toneColour(p.tone);
    const look =
      p.state === 'connected'
        ? { fill: tone, stroke: tone, width: 2 }
        : p.state === 'bubbled'
          ? { fill: TONE.failed, stroke: tone, width: 2, dash: '2 2' }
          : { fill: INK.bg, stroke: TONE.unreachable, width: 2.5 };
    out.push(square(c.x, c.y, 12, look), portName(c.x, c.y, p.side, p.name, INK.muted));
  }
  return out.join('');
}

function wiresSvg(scene: Scene): { paths: string; labels: string } {
  const paths: string[] = [];
  const labels: string[] = [];
  const all = [
    ...scene.view.edges.map((e) => ({
      id: e.id,
      tone: e.tone,
      problem: e.problem,
      label: e.sourcePort,
    })),
    ...(scene.boundary?.edges ?? []).map((e) => ({
      id: e.id,
      tone: e.tone,
      problem: e.problem,
      label: e.label,
    })),
  ];
  for (const e of all) {
    const w = scene.wires.get(e.id);
    if (!w) continue;
    const colour = toneColour(e.tone);
    const dash = e.problem ? ' stroke-dasharray="5 4"' : '';
    paths.push(
      `<path d="${w.path}" fill="none" stroke="${colour}" stroke-width="1.6"${dash} marker-end="url(#afd-arrow-${e.tone})"/>`,
    );
    if (e.label) {
      const tw = textWidth(e.label, 10, { mono: true });
      labels.push(
        `<rect x="${n2(w.label.x - tw / 2 - 4)}" y="${n2(w.label.y - 8)}" width="${n2(tw + 8)}" height="16" rx="2" fill="${INK.bg}"/>`,
        text(w.label.x, w.label.y + 3.5, e.label, {
          'font-size': 10,
          fill: INK.muted,
          'font-family': MONO,
          'text-anchor': 'middle',
        }),
      );
    }
  }
  return { paths: paths.join(''), labels: labels.join('') };
}

export interface SvgOptions {
  /** draw.io file to embed in the `content` attribute (`.drawio.svg`). */
  embed?: string;
}

/** The SVG of one scene, with its title block, on a white background. */
export function sceneSvg(src: ExportSource, scene: Scene, opts: SvgOptions = {}): string {
  const { dx, dy } = shiftOf(scene);
  const flow = src.doc.flow;
  const where = scene.level === ROOT ? 'Top level' : `Subflow ${scene.path}: ${scene.title}`;
  const head = `${flow.name} · v${flow.version}`;
  const titleWidth = Math.max(
    textWidth(head, 15, { bold: true }),
    textWidth(where, 12),
    flow.goal ? textWidth(flow.goal, 12) : 0,
  );
  const width = Math.ceil(Math.max(scene.bounds.width + 80, Math.min(titleWidth, 900) + 80));
  const height = Math.ceil(scene.bounds.height + 160);
  const wires = wiresSvg(scene);
  const title = [
    text(40, 38, head, { 'font-size': 15, 'font-weight': 700, fill: INK.fg }),
    text(40, 58, where, { 'font-size': 12, fill: INK.fg }),
    ...(flow.goal
      ? [
          text(40, 76, fitText(flow.goal, width - 80, 12), {
            'font-size': 12,
            fill: INK.muted,
            'font-style': 'italic',
          }),
        ]
      : []),
  ].join('');
  const content = opts.embed ? ` content="${attr(opts.embed)}"` : '';
  return [
    `<?xml version="1.0" encoding="UTF-8"?>\n`,
    `<svg xmlns="http://www.w3.org/2000/svg" version="1.1" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="${esc(FONT)}" style="background-color:${INK.bg}"${content}>`,
    `<defs>${markers()}</defs>`,
    `<rect width="${width}" height="${height}" fill="${INK.bg}"/>`,
    title,
    `<g transform="translate(${dx} ${dy})">`,
    sectionsSvg(scene),
    frameSvg(scene),
    wires.paths,
    ...scene.view.nodes.map((v) => nodeSvg(v) + portsSvg(v)),
    notesSvg(scene),
    wires.labels,
    '</g></svg>\n',
  ].join('');
}

const NOTE_COLOURS = NOTE_COLORS.light;
const colourOf = (a: AnnotationView) =>
  NOTE_COLOURS[a.annotation.color ?? (a.kind === 'note' ? 'yellow' : 'gray')];

/** AFD-66: Sections behind everything, titled in their ink. */
function sectionsSvg(scene: Scene): string {
  return scene.view.annotations
    .filter((a) => a.kind === 'section')
    .map((a) => {
      const c = colourOf(a);
      const { x, y } = a.position;
      const title = fitText(plainText(a.annotation.text).split('\n')[0] ?? '', a.width - 24, 13, {
        bold: true,
      });
      return `<rect x="${n2(x + 1)}" y="${n2(y + 1)}" width="${n2(a.width - 2)}" height="${n2(a.height - 2)}" rx="8" fill="${c.fill}" fill-opacity="0.35" stroke="${c.ink}" stroke-width="2"/>${text(x + 14, y + 22, title, { 'font-size': 13, 'font-weight': 700, fill: c.ink })}`;
    })
    .join('');
}

/** AFD-66: Notes as cards with their tie, Text as words; Markdown as plain text. */
function notesSvg(scene: Scene): string {
  const nodes = new Map(scene.view.nodes.map((n) => [n.node.id, n]));
  return scene.view.annotations
    .filter((a) => a.kind !== 'section')
    .map((a) => {
      const c = colourOf(a);
      const { x, y } = a.position;
      const words = plainText(a.annotation.text);
      if (a.kind === 'text') {
        const size = a.annotation.size === 's' ? 13 : a.annotation.size === 'l' ? 26 : 18;
        return wrapText(words, a.width, size)
          .map((l, i) =>
            text(x, y + size + i * size * 1.3, l, {
              'font-size': size,
              'font-weight': 700,
              fill: c.ink,
            }),
          )
          .join('');
      }
      const node = a.on ? nodes.get(a.on) : undefined;
      const line = node
        ? tieLine(
            { ...a.position, width: a.width, height: a.height },
            { ...node.position, width: node.width, height: node.height },
          )
        : undefined;
      const tie = line
        ? `<line x1="${n2(line.from.x)}" y1="${n2(line.from.y)}" x2="${n2(line.to.x)}" y2="${n2(line.to.y)}" stroke="${c.ink}" stroke-width="1.5" stroke-dasharray="4 3"/>`
        : '';
      const rows = wrapText(words, a.width - 20, 12).slice(
        0,
        Math.max(1, Math.floor((a.height - 12) / 16)),
      );
      return `${tie}<rect x="${n2(x)}" y="${n2(y)}" width="${n2(a.width)}" height="${n2(a.height)}" rx="4" fill="${c.fill}" stroke="${c.ink}" stroke-opacity="0.35"/>${rows
        .map((l, i) => text(x + 10, y + 20 + i * 16, l, { 'font-size': 12, fill: INK.fg }))
        .join('')}`;
    })
    .join('');
}

/** SVG of one level (ROOT or a subflow node ID). */
export function toSvg(src: ExportSource, level: string = ROOT, opts: SvgOptions = {}): string {
  const scene = scenesOf(src, level)[0];
  if (!scene) throw new Error(`No level ${level} in this flow`);
  return sceneSvg(src, scene, opts);
}

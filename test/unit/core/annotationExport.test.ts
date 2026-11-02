// AFD-66: draw.io and SVG pictures carry the annotations: Sections behind, Notes as draw.io notes
// tied to their nodes, Text as words; Markdown as escaped simple HTML (draw.io) or plain text (SVG).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { toDrawio } from '../../../src/core/export/drawio';
import { scenesOf } from '../../../src/core/export/scene';
import { toSvg } from '../../../src/core/export/svg';
import { buildModel } from '../../../src/core/flow/model';
import { openFailPorts } from '../../../src/core/flow/openPorts';
import type { FlowDocument } from '../../../src/core/flow/types';

const doc = parse(
  readFileSync(join(__dirname, '../../fixtures/flows/annotated.flow.yaml'), 'utf8'),
) as FlowDocument;
const src = {
  doc,
  shown: { stored: doc.layout ?? {}, auto: {} },
  findings: [],
  openPorts: openFailPorts(buildModel(doc)),
};
const id = (key: string) => doc.annotations?.find((a) => a.key === key)?.id as string;

describe('annotations in exports (AFD-66)', () => {
  it('draw.io: a section behind, notes as notes tied to their nodes, text, Markdown as HTML', () => {
    const xml = toDrawio(src);
    const at = (cell: string) => xml.indexOf(`id="${cell}"`);
    expect(at(id('section-1'))).toBeGreaterThan(0);
    // The section comes before the nodes (behind them); notes after.
    const precheck = doc.nodes.find((n) => n.key === 'precheck')?.id as string;
    expect(at(id('section-1'))).toBeLessThan(at(precheck));
    expect(at(id('note-1'))).toBeGreaterThan(at(precheck));
    expect(xml).toContain('shape=note');
    expect(xml).toMatch(new RegExp(`source="${id('note-1')}" target="${precheck}"`));
    // Markdown as escaped simple HTML in the label.
    expect(xml).toContain('&lt;b&gt;safe&lt;/b&gt;');
    expect(xml).toContain('annotation="text"');
  });

  it('SVG: the picture grows to hold them; notes, the section title and the tie are drawn', () => {
    const svg = toSvg(src);
    expect(svg).toContain('Read-only checks: safe to rerun.');
    expect(svg).toContain('>Change window<');
    expect(svg).toContain('stroke-dasharray="4 3"');
    expect(svg).not.toContain('**');
    const scene = scenesOf(src)[0];
    const pink = scene?.view.annotations.find((a) => a.annotation.key === 'note-3');
    expect(scene?.bounds.x).toBeLessThanOrEqual(pink?.position.x ?? 0);
    expect((scene?.bounds.x ?? 0) + (scene?.bounds.width ?? 0)).toBeGreaterThanOrEqual(
      (pink?.position.x ?? 0) + (pink?.width ?? 0),
    );
  });
});

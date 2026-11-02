// AFD-25 (in the jsdom project for its XML parser): exports draw the canvas's own geometry. A draw.io file has a page per level with the
// node details as shape data; wires attach to port shapes; images embed the draw.io file the way
// draw.io does (SVG `content`, PNG zTXt `mxGraphModel`).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { deflateRawSync, deflateSync, inflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { contractText, nodeDetails } from '../../../src/core/export/details';
import { shiftOf, toDrawio } from '../../../src/core/export/drawio';
import { crc32, diagramInPng, embedDiagramInPng } from '../../../src/core/export/png';
import { type ExportSource, levelSuffix, scenesOf } from '../../../src/core/export/scene';
import { sceneSvg, toSvg } from '../../../src/core/export/svg';
import { fitText, textWidth } from '../../../src/core/export/text';
import { buildModel, ROOT } from '../../../src/core/flow/model';
import { openFailPorts } from '../../../src/core/flow/openPorts';
import { createSchemaValidator } from '../../../src/core/flow/schema';
import type { FlowDocument } from '../../../src/core/flow/types';
import { validateFlow } from '../../../src/core/flow/validate';
import { pointsOf, runsThrough } from '../../../src/core/view/route';
import { shownPositions } from '../../../src/node/autoLayout';
import { readExample } from '../core/helpers';

const schema = createSchemaValidator();
const xml = (text: string, type: 'text/xml' | 'image/svg+xml' = 'text/xml') => {
  const doc = new DOMParser().parseFromString(text, type);
  expect(doc.getElementsByTagName('parsererror')).toHaveLength(0);
  return doc;
};

async function source(text: string): Promise<ExportSource> {
  const doc = parse(text) as FlowDocument;
  const model = buildModel(doc);
  return {
    doc,
    shown: await shownPositions(model),
    findings: validateFlow(doc, schema(doc)).findings,
    openPorts: openFailPorts(model),
  };
}

const sample = () =>
  readFileSync(join(__dirname, '../../../samples/firewall-upgrade.flow.yaml'), 'utf8');

describe('draw.io export (AFD-25)', () => {
  it('a page per level, subflow nodes link to their page, pages link back', async () => {
    const src = await source(sample());
    const scenes = scenesOf(src);
    const file = xml(toDrawio(src));
    const pages = [...file.getElementsByTagName('diagram')];
    expect(pages.map((p) => p.getAttribute('name'))).toEqual(
      scenes.map((s) => (s.level === ROOT ? src.doc.flow.name : `${s.title} (${s.path})`)),
    );
    expect(pages.length).toBeGreaterThan(3);
    const ids = new Set(pages.map((p) => p.getAttribute('id')));
    for (const page of pages) {
      const cells = [...page.getElementsByTagName('UserObject')];
      // Every link names a page of the file.
      for (const c of cells.filter((x) => x.hasAttribute('link')))
        expect(ids).toContain(c.getAttribute('link')?.replace('data:page/id,', ''));
      // Every wire starts and ends at a shape on this page.
      const here = new Set(
        [...page.querySelectorAll('UserObject, mxCell')].map((c) => c.getAttribute('id')),
      );
      for (const edge of page.querySelectorAll('mxCell[edge="1"]')) {
        expect(here).toContain(edge.getAttribute('source'));
        expect(here).toContain(edge.getAttribute('target'));
      }
    }
    // Subflow pages carry a frame and a title linking to the parent page.
    const upgrade = pages.find((p) => p.getAttribute('name')?.endsWith('(upgrade)'));
    expect(upgrade?.querySelector('UserObject[id="afd-frame"]')).not.toBeNull();
    expect(upgrade?.querySelector('UserObject[id="afd-title"]')?.getAttribute('link')).toBe(
      'data:page/id,afd-root',
    );
  });

  it('nodes carry their details; the page background carries the flow', async () => {
    const src = await source(readExample('os-upgrade.flow.yaml'));
    const top = xml(toDrawio(src)).getElementsByTagName('diagram')[0];
    if (!top) throw new Error('no page');
    const node = (key: string) => top.querySelector(`UserObject[key="${key}"]`);
    const pre = node('pre-checks');
    expect(pre?.getAttribute('type')).toBe('task');
    expect(pre?.getAttribute('status')).toBe('implemented');
    expect(pre?.getAttribute('intent')).toBeTruthy();
    expect(pre?.getAttribute('tooltip')).toContain('Pre-checks');
    // Open on purpose, with its reason, on the node and on the port shape.
    const backup = node('backup-config');
    expect(backup?.getAttribute('open_on_purpose')).toBe('failed_hosts: Fails before any change');
    const port = top.querySelector(`UserObject[id="${backup?.getAttribute('id')}:failed_hosts"]`);
    expect(port?.getAttribute('reason')).toBe('Fails before any change');
    // Binding and parameters.
    const upgrade = node('upgrade-os');
    expect(upgrade?.getAttribute('binding')).toBe('role: netops.os_upgrade');
    expect(upgrade?.getAttribute('link')).toMatch(/^data:page\/id,afd-/);
    // Drafts are dashed on white; implemented steps get the green fill and border.
    const style = node('rollback')?.firstElementChild?.getAttribute('style') ?? '';
    expect(style).toContain('dashed=1');
    expect(style).toContain('fillColor=#ffffff');
    const done = pre?.firstElementChild?.getAttribute('style') ?? '';
    expect(done).toContain('fillColor=#e9f7f1');
    expect(done).not.toContain('dashed=1');
    const root = top.querySelector('UserObject[id="0"]');
    expect(root?.getAttribute('flow')).toBe(src.doc.flow.name);
    expect(root?.getAttribute('version')).toBe(String(src.doc.flow.version));
    expect(root?.getAttribute('problems')).toMatch(/^\d+ error\(s\), \d+ warning\(s\), \d+ info$/);
  });

  it('positions are the canvas positions, shifted below the title block', async () => {
    const src = await source(sample());
    const scene = scenesOf(src, ROOT)[0];
    const top = xml(toDrawio(src)).getElementsByTagName('diagram')[0];
    if (!top) throw new Error('no page');
    const v = scene?.view.nodes[0];
    const geo = top.querySelector(`UserObject[id="${v?.node.id}"] mxGeometry`);
    const dx = Number(geo?.getAttribute('x')) - (v?.position.x ?? 0);
    const dy = Number(geo?.getAttribute('y')) - (v?.position.y ?? 0);
    for (const n of scene?.view.nodes ?? []) {
      const g = top.querySelector(`UserObject[id="${n.node.id}"] mxGeometry`);
      expect(Number(g?.getAttribute('x'))).toBe(n.position.x + dx);
      expect(Number(g?.getAttribute('y'))).toBe(n.position.y + dy);
      expect(Number(g?.getAttribute('width'))).toBe(n.width);
    }
  });

  it('AFD-70: no wire runs through a node; a routed wire keeps its corners as waypoints', async () => {
    const src = await source(sample());
    const pages = [...xml(toDrawio(src)).getElementsByTagName('diagram')];
    let routed = 0;
    for (const scene of scenesOf(src)) {
      const boxes = scene.view.nodes.map((n) => ({
        ...n.position,
        width: n.width,
        height: n.height,
      }));
      const page = pages.find((p) => p.getAttribute('id') === `afd-${scene.level}`);
      const { dx, dy } = shiftOf(scene);
      for (const [id, w] of scene.wires) {
        expect(runsThrough(pointsOf(w.path), boxes), id).toBe(false);
        const points = [...(page?.querySelectorAll(`UserObject[id="${id}"] mxPoint`) ?? [])];
        expect(
          points.map((p) => [Number(p.getAttribute('x')), Number(p.getAttribute('y'))]),
        ).toEqual((w.bends ?? []).map((b) => [b.x + dx, b.y + dy]));
        if (w.bends) routed++;
      }
    }
    // The sample's top level had three wires through nodes, its Pre-checks one.
    expect(routed).toBe(4);
  });

  it('details: contract fields on one line each, problems with their code', async () => {
    expect(
      contractText({
        fos_version: { type: 'string', required: true, from: 'precheck.fos_version' },
        retries: { type: 'integer', default: 3 },
      }),
    ).toBe('fos_version: string (required) <- precheck.fos_version\nretries: integer = 3');
    const src = await source(sample());
    const model = buildModel(src.doc);
    const withProblem = src.findings.find((f) => f.node);
    if (!withProblem?.node) return;
    const node = model.nodes.get(withProblem.node)?.node;
    if (!node) throw new Error('fixture');
    const details = Object.fromEntries(
      nodeDetails(node, { model, findings: src.findings, openPorts: src.openPorts }),
    );
    expect(details.problems).toContain(withProblem.code);
  });
});

describe('SVG export (AFD-25)', () => {
  it('draws every node, wire and title, and embeds the draw.io file', async () => {
    const src = await source(sample());
    for (const scene of scenesOf(src)) {
      const embed = toDrawio(src, { first: scene.level });
      const svg = xml(sceneSvg(src, scene, { embed }), 'image/svg+xml');
      const root = svg.documentElement;
      expect(root.getAttribute('content')).toBe(embed);
      const texts = [...svg.getElementsByTagName('text')].map((t) => t.textContent ?? '');
      for (const v of scene.view.nodes)
        expect(
          texts.some(
            (t) =>
              t === v.node.title || (t.endsWith('…') && v.node.title.startsWith(t.slice(0, -1))),
          ),
        ).toBe(true);
      const wires = scene.view.edges.length + (scene.boundary?.edges.length ?? 0);
      expect(svg.querySelectorAll('path[marker-end]')).toHaveLength(wires);
      // The embedded file opens on this level's page.
      expect(xml(embed).getElementsByTagName('diagram')[0]?.getAttribute('id')).toBe(
        `afd-${scene.level}`,
      );
    }
  });

  it('file names: the top level plain, subflows by key path', async () => {
    const src = await source(sample());
    const names = scenesOf(src).map(levelSuffix);
    expect(names[0]).toBe('');
    expect(names).toContain('--upgrade');
    expect(levelSuffix({ path: 'upgrade/wait-ha' })).toBe('--upgrade--wait-ha');
    expect(() => toSvg(src, 'nope')).toThrow(/No level/);
  });

  it('titles are cut with an ellipsis to fit', () => {
    const long = 'Wait for the firewall cluster to report both members in sync again';
    const cut = fitText(long, 174, 12.5, { bold: true });
    expect(cut.endsWith('…')).toBe(true);
    expect(textWidth(cut, 12.5, { bold: true })).toBeLessThanOrEqual(174);
    expect(fitText('Check NTP', 174, 12.5)).toBe('Check NTP');
  });
});

describe('PNG embedding (AFD-25)', () => {
  /** A 1x1 white PNG built by hand. */
  function tinyPng(): Uint8Array {
    const chunk = (type: string, data: Uint8Array) => {
      const out = Buffer.alloc(12 + data.length);
      out.writeUInt32BE(data.length, 0);
      out.write(type, 4, 'latin1');
      Buffer.from(data).copy(out, 8);
      out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
      return out;
    };
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(1, 0);
    ihdr.writeUInt32BE(1, 4);
    ihdr.set([8, 2, 0, 0, 0], 8);
    return Buffer.concat([
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      chunk('IHDR', ihdr),
      chunk('IDAT', deflateSync(Buffer.from([0, 255, 255, 255]))),
      chunk('IEND', new Uint8Array()),
    ]);
  }

  it('crc32 is the PNG checksum', () => {
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
  });

  it('writes the diagram as draw.io does and reads it back; a second embed replaces the first', () => {
    const diagram = '<mxfile><diagram id="a" name="Top &amp; more">ü</diagram></mxfile>';
    const once = embedDiagramInPng(tinyPng(), diagram, (b) => deflateRawSync(b));
    expect(diagramInPng(once, (b) => inflateRawSync(b))).toBe(diagram);
    const twice = embedDiagramInPng(once, '<mxfile/>', (b) => deflateRawSync(b));
    expect(diagramInPng(twice, (b) => inflateRawSync(b))).toBe('<mxfile/>');
    expect(twice.length).toBeLessThan(once.length);
    // Chunk order stays valid: the signature, IHDR first, IEND last.
    expect(Buffer.from(twice.subarray(12, 16)).toString('latin1')).toBe('IHDR');
    expect(Buffer.from(twice.subarray(-8, -4)).toString('latin1')).toBe('IEND');
    expect(() => embedDiagramInPng(new Uint8Array([1, 2, 3]), diagram, (b) => b)).toThrow(/PNG/);
  });
});

// AFD-25 inside VS Code: the export commands write a draw.io file (a page per level, node details
// as shape data) and images of the top level or every level. SVG needs no designer; PNG is drawn by
// the designer, which opens for it, and carries the draw.io file as draw.io writes it.
import * as assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { getSmoothStepPath, Position as Side } from '@xyflow/system';
import * as vscode from 'vscode';
import { diagramInPng } from '../../src/core/export/png';
import type { Position } from '../../src/core/flow/types';
import { pointsOf } from '../../src/core/view/route';
import { closeAll, flowUri, openDesigner, sha, testApi, VIEW_TYPE } from './helpers';

const designerTabs = () =>
  vscode.window.tabGroups.all
    .flatMap((g) => g.tabs)
    .filter((t) => t.input instanceof vscode.TabInputCustom && t.input.viewType === VIEW_TYPE);

function outDir(): string {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri;
  if (!root) throw new Error('no workspace');
  return join(root.fsPath, 'exports');
}

describe('AFD-25 acceptance: export', () => {
  afterEach(closeAll);
  after(() => vscode.workspace.fs.delete(vscode.Uri.file(outDir()), { recursive: true }));

  it('Export as draw.io writes every level as a page, with the node details; the flow stays as it was', async () => {
    await testApi();
    const uri = flowUri('os-upgrade');
    const before = sha(uri);
    const file = join(outDir(), 'os-upgrade.drawio');
    const written = await vscode.commands.executeCommand<string[]>('afd.export.drawio', uri, {
      out: file,
      quiet: true,
    });
    assert.deepEqual(written, [file]);
    const xml = readFileSync(file, 'utf8');
    assert.match(xml, /^<mxfile [^>]*pages="2"><diagram id="afd-root"/);
    assert.match(
      xml,
      /key="backup-config"[^>]*open_on_purpose="failed_hosts: Fails before any change"/,
    );
    assert.match(xml, /key="upgrade-os"[^>]*binding="role: netops.os_upgrade"/);
    assert.equal(sha(uri), before);
  });

  it('Export as image writes an SVG per level from the Explorer, without opening the designer', async () => {
    const uri = flowUri('os-upgrade');
    const file = join(outDir(), 'os.drawio.svg');
    const written = await vscode.commands.executeCommand<string[]>('afd.export.image', uri, {
      out: file,
      format: 'svg',
      level: 'all',
      quiet: true,
    });
    assert.deepEqual(
      written.map((p) => basename(p)),
      ['os.drawio.svg', 'os--upgrade-os.drawio.svg'],
    );
    const sub = readFileSync(written[1] as string, 'utf8');
    // The subflow's image opens on its own page in draw.io.
    assert.match(sub, /<svg [^>]*content="&lt;mxfile [^"]*&gt;&lt;diagram id=&quot;afd-01/);
    assert.match(sub, /Subflow boundary · /);
    assert.equal(designerTabs().length, 0);
  });

  it('AFD-70: the canvas draws the wires the export draws, routed round nodes where they would cross one', async () => {
    const api = await testApi();
    const uri = flowUri('os-upgrade');
    await openDesigner(uri);
    const drawn = Object.values((await api.inspect(uri)).wires ?? {});
    const file = join(outDir(), 'os-wires.svg');
    await vscode.commands.executeCommand('afd.export.image', uri, {
      out: file,
      format: 'svg',
      level: 'root',
      quiet: true,
    });
    const svg = readFileSync(file, 'utf8');
    const exported = [...svg.matchAll(/<path d="([^"]+)"[^>]*marker-end="url\(#afd-arrow-/g)].map(
      (m) => m[1] ?? '',
    );
    assert.ok(drawn.length > 10, `${drawn.length} wires drawn`);
    assert.equal(drawn.length, exported.length);
    // The canvas measures its handles and the export computes them, so ends differ by a pixel or a
    // few (as before AFD-70); each wire turns at the same places give or take that.
    const near = (u: number, v: number) => Math.abs(u - v) < 2;
    const shape = (d: string) => {
      const out: Position[] = [];
      for (const p of pointsOf(d)) {
        const q = out.at(-1);
        if (q && near(p.x, q.x) && near(p.y, q.y)) continue;
        const o = out.at(-2);
        if (o && q && ((near(o.x, q.x) && near(q.x, p.x)) || (near(o.y, q.y) && near(q.y, p.y))))
          out.pop();
        out.push(p);
      }
      return out;
    };
    const alike = (d: string, e: string) => {
      const [p, q] = [shape(d), shape(e)];
      return (
        p.length === q.length &&
        p.every(
          (pt, i) => Math.abs(pt.x - (q[i]?.x ?? 0)) <= 8 && Math.abs(pt.y - (q[i]?.y ?? 0)) <= 8,
        )
      );
    };
    for (const d of drawn)
      assert.ok(
        exported.some((e) => alike(d, e)),
        `not exported: ${d}`,
      );
    // One of os-upgrade's wires would run through steps (Upgrade needed? `false` to Done): on both,
    // that one, and only that one, is not the plain smooth step between its ends. Before AFD-192
    // there were two; with ELK laying out on the canvas ports Notify on-call sits right of the
    // column, so Drain traffic's `failed_hosts` wire has no node in its way (AFD-228).
    const sideOf = (p: Position, q: Position) =>
      q.x > p.x ? Side.Right : q.x < p.x ? Side.Left : q.y > p.y ? Side.Bottom : Side.Top;
    const routed = (d: string) => {
      const pts = pointsOf(d);
      const [a, b] = [pts[0] as Position, pts.at(-1) as Position];
      const [path] = getSmoothStepPath({
        sourceX: a.x,
        sourceY: a.y,
        sourcePosition: sideOf(a, pts[1] as Position),
        targetX: b.x,
        targetY: b.y,
        targetPosition: sideOf(b, pts.at(-2) as Position),
      });
      return path !== d;
    };
    assert.equal(drawn.filter(routed).length, 1);
    assert.equal(exported.filter(routed).length, 1);
  });

  it('PNG: the designer opens and draws it at twice the size; the PNG holds the draw.io file', async () => {
    const uri = flowUri('edge-baseline');
    const file = join(outDir(), 'edge.drawio.png');
    const written = await vscode.commands.executeCommand<string[]>('afd.export.image', uri, {
      out: file,
      format: 'png',
      level: 'root',
      quiet: true,
    });
    assert.deepEqual(written, [file]);
    const png = readFileSync(file);
    assert.deepEqual([...png.subarray(1, 4)], [80, 78, 71]);
    const svg = readFileSync(
      (
        await vscode.commands.executeCommand<string[]>('afd.export.image', uri, {
          out: join(outDir(), 'edge.svg'),
          format: 'svg',
          level: 'root',
          quiet: true,
        })
      )[0] as string,
      'utf8',
    );
    const width = Number(/<svg [^>]*width="(\d+)"/.exec(svg)?.[1]);
    assert.equal(png.readUInt32BE(16), width * 2);
    const diagram = diagramInPng(png, (b) => inflateRawSync(b));
    assert.match(diagram ?? '', /^<mxfile [^>]*><diagram id="afd-root"/);
    assert.match(diagram ?? '', /key="push-baseline"/);
    assert.equal(designerTabs().length, 1);
  });
});

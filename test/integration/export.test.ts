// AFD-25 inside VS Code: the export commands write a draw.io file (a page per level, node details
// as shape data) and images of the top level or every level. SVG needs no designer; PNG is drawn by
// the designer, which opens for it, and carries the draw.io file as draw.io writes it.
import * as assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { inflateRawSync } from 'node:zlib';
import * as vscode from 'vscode';
import { diagramInPng } from '../../src/core/export/png';
import { closeAll, flowUri, sha, testApi, VIEW_TYPE } from './helpers';

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
    const written = await vscode.commands.executeCommand<string[]>('afd.exportDrawio', uri, {
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
    const written = await vscode.commands.executeCommand<string[]>('afd.exportImage', uri, {
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

  it('PNG: the designer opens and draws it at twice the size; the PNG holds the draw.io file', async () => {
    const uri = flowUri('edge-baseline');
    const file = join(outDir(), 'edge.drawio.png');
    const written = await vscode.commands.executeCommand<string[]>('afd.exportImage', uri, {
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
        await vscode.commands.executeCommand<string[]>('afd.exportImage', uri, {
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

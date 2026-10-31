// Export a flow as a draw.io diagram or as images (AFD-25): the Command Palette, the Explorer's
// right-click on a *.flow.yaml, and the designer's "…" menu. Exports draw from the session's
// snapshot, so they show what the canvas shows (stored and auto positions, problems, open ports).
// Images embed the draw.io file (`.drawio.svg`, `.drawio.png`), so draw.io opens them as diagrams.
// PNG needs a browser for its text: a designer panel draws it, and opens first when needed.
import { deflateRawSync } from 'node:zlib';
import * as vscode from 'vscode';
import { toDrawio } from '../core/export/drawio';
import { embedDiagramInPng } from '../core/export/png';
import { type ExportSource, levelSuffix, type Scene, scenesOf } from '../core/export/scene';
import { sceneSvg } from '../core/export/svg';
import { ROOT } from '../core/flow/model';
import type { FlowSession } from './flowSession';

export type ImageFormat = 'svg' | 'png';

/** Arguments for scripts and tests; anything left out is asked for. */
export interface ExportOptions {
  /** File to write. For every level: the top level's file, the others go next to it. */
  out?: string;
  /** ROOT, a subflow node ID, or `all`. */
  level?: string;
  format?: ImageFormat;
  /** No message with Open / Reveal buttons afterwards. */
  quiet?: boolean;
}

export interface ExportDeps {
  /** The flow's session: the given file, else the active designer or flow editor. */
  session(uri?: vscode.Uri): Promise<FlowSession | undefined>;
  /** The flow's session with a designer panel loaded (opens the designer when none is). */
  designer(uri: vscode.Uri): Promise<FlowSession>;
  agent: string;
}

/** What an export is drawn from: the snapshot the canvas shows. */
export async function exportSource(session: FlowSession): Promise<ExportSource> {
  const s = await session.snapshot();
  if (!s.doc || s.stale)
    throw new Error(`${s.parseError ?? 'The flow does not parse'}; fix the file before exporting`);
  return {
    doc: s.doc,
    shown: { stored: s.doc.layout ?? {}, auto: s.autoPositions },
    findings: s.findings,
    openPorts: s.openPorts,
  };
}

const utf8 = (text: string) => new TextEncoder().encode(text);
const folderOf = (uri: vscode.Uri) => vscode.Uri.joinPath(uri, '..');

async function announce(files: vscode.Uri[], what: string, quiet?: boolean): Promise<void> {
  if (quiet || files.length === 0) return;
  const first = files[0] as vscode.Uri;
  const name = first.path.split('/').pop();
  const more = files.length > 1 ? ` and ${files.length - 1} more` : '';
  const pick = await vscode.window.showInformationMessage(
    `Exported ${what}: ${name}${more}.`,
    'Open',
    'Reveal',
  );
  if (pick === 'Open') await vscode.commands.executeCommand('vscode.open', first);
  if (pick === 'Reveal') await vscode.commands.executeCommand('revealFileInOS', first);
}

async function sessionOrSay(deps: ExportDeps, uri?: vscode.Uri): Promise<FlowSession | undefined> {
  const session = await deps.session(uri);
  if (!session)
    void vscode.window.showWarningMessage(
      'Open a flow (*.flow.yaml), or right-click one, to export it.',
    );
  return session;
}

/** Every level as a page of one draw.io file. Returns the written file paths. */
export async function exportDrawio(
  deps: ExportDeps,
  uri?: vscode.Uri,
  opts: ExportOptions = {},
): Promise<string[]> {
  const session = await sessionOrSay(deps, uri);
  if (!session) return [];
  try {
    const src = await exportSource(session);
    const target = opts.out
      ? vscode.Uri.file(opts.out)
      : await vscode.window.showSaveDialog({
          title: 'Export flow as a draw.io diagram',
          defaultUri: vscode.Uri.joinPath(folderOf(session.uri), `${src.doc.flow.key}.drawio`),
          filters: { 'draw.io diagram': ['drawio'] },
        });
    if (!target) return [];
    await vscode.workspace.fs.writeFile(target, utf8(toDrawio(src, { agent: deps.agent })));
    void announce([target], 'the draw.io diagram', opts.quiet);
    return [target.fsPath];
  } catch (e) {
    void vscode.window.showErrorMessage(`Export failed: ${(e as Error).message}`);
    return [];
  }
}

async function pickFormat(): Promise<ImageFormat | undefined> {
  const picked = await vscode.window.showQuickPick(
    [
      { label: 'SVG', description: 'vector image, .drawio.svg', format: 'svg' as const },
      {
        label: 'PNG',
        description: 'raster image at twice the size, .drawio.png',
        format: 'png' as const,
      },
    ],
    { title: 'Export as image', placeHolder: 'Image format' },
  );
  return picked?.format;
}

async function pickLevel(scenes: Scene[]): Promise<string | undefined> {
  if (scenes.length <= 1) return ROOT;
  const picked = await vscode.window.showQuickPick(
    [
      { label: 'Top level', description: 'one image', level: ROOT },
      {
        label: 'Every level',
        description: `${scenes.length} images: the top level and each subflow`,
        level: 'all',
      },
    ],
    { title: 'Export as image', placeHolder: 'Which levels' },
  );
  return picked?.level;
}

/** Splits `name.drawio.svg` (or `name.svg`) into stem and extension. */
function splitName(path: string, format: ImageFormat): { stem: string; ext: string } {
  const ext = path.toLowerCase().endsWith(`.drawio.${format}`) ? `.drawio.${format}` : `.${format}`;
  return {
    stem: path.toLowerCase().endsWith(ext) ? path.slice(0, -ext.length) : path,
    ext: path.toLowerCase().endsWith(ext) ? path.slice(-ext.length) : ext,
  };
}

const sizeOf = (svg: string) => {
  const m = /<svg[^>]* width="(\d+)" height="(\d+)"/.exec(svg);
  return { width: Number(m?.[1] ?? 800), height: Number(m?.[2] ?? 600) };
};

/** One level, or every level as one file each. Returns the written file paths. */
export async function exportImage(
  deps: ExportDeps,
  uri?: vscode.Uri,
  opts: ExportOptions = {},
): Promise<string[]> {
  const session = await sessionOrSay(deps, uri);
  if (!session) return [];
  try {
    const src = await exportSource(session);
    const all = scenesOf(src);
    const format = opts.format ?? (await pickFormat());
    if (!format) return [];
    const level = opts.level ?? (await pickLevel(all));
    if (!level) return [];
    const scenes = level === 'all' ? all : all.filter((s) => s.level === level);
    const first = scenes[0];
    if (!first) throw new Error('that level is not in the flow');
    const target = opts.out
      ? vscode.Uri.file(opts.out)
      : await vscode.window.showSaveDialog({
          title:
            scenes.length > 1
              ? `Export ${scenes.length} images (the others are named after this one)`
              : 'Export as image',
          defaultUri: vscode.Uri.joinPath(
            folderOf(session.uri),
            `${src.doc.flow.key}${levelSuffix(first)}.drawio.${format}`,
          ),
          filters: { [format.toUpperCase()]: [format] },
        });
    if (!target) return [];
    // The chosen name is the first level's; with every level, the others get their suffix.
    const { stem, ext } = splitName(target.path, format);
    const base = scenes.length > 1 ? stem.slice(0, stem.length - levelSuffix(first).length) : stem;
    const designer = format === 'png' ? await deps.designer(session.uri) : undefined;
    const written: vscode.Uri[] = [];
    for (const scene of scenes) {
      const file = target.with({
        path: scenes.length > 1 ? `${base}${levelSuffix(scene)}${ext}` : `${stem}${ext}`,
      });
      const diagram = toDrawio(src, { first: scene.level, agent: deps.agent });
      let bytes: Uint8Array;
      if (designer) {
        const svg = sceneSvg(src, scene);
        const { width, height } = sizeOf(svg);
        const png = await designer.renderPng(svg, width, height);
        bytes = embedDiagramInPng(png, diagram, (b) => deflateRawSync(b));
      } else bytes = utf8(sceneSvg(src, scene, { embed: diagram }));
      await vscode.workspace.fs.writeFile(file, bytes);
      written.push(file);
    }
    void announce(written, scenes.length > 1 ? 'the images' : 'the image', opts.quiet);
    return written.map((u) => u.fsPath);
  } catch (e) {
    void vscode.window.showErrorMessage(`Export failed: ${(e as Error).message}`);
    return [];
  }
}

export function registerExport(deps: ExportDeps): vscode.Disposable[] {
  return [
    vscode.commands.registerCommand('afd.exportDrawio', (uri?: vscode.Uri, opts?: ExportOptions) =>
      exportDrawio(deps, uri instanceof vscode.Uri ? uri : undefined, opts),
    ),
    vscode.commands.registerCommand('afd.exportImage', (uri?: vscode.Uri, opts?: ExportOptions) =>
      exportImage(deps, uri instanceof vscode.Uri ? uri : undefined, opts),
    ),
  ];
}

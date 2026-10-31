// Flow files on disk for the MCP server (AFD-19). Only *.flow.yaml inside the roots (the client's
// MCP roots, else the working directory) are seen or written. A write acts like a save in the
// designer: tested nodes changed by the edit drop back, flow.version moves once against Git HEAD,
// and generated/ is refreshed without overwriting hand edits. Files are replaced atomically.
import { execFile } from 'node:child_process';
import { promises as fs, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { findNodeAtLocation, getNodeValue, parseTree } from 'jsonc-parser';
import type { FlowIO } from '../core/ai/handlers';
import type { OpsContext } from '../core/ai/ops';
import { planGenerated } from '../core/engine/writePlan';
import type { IdFactory } from '../core/flow/ids';
import { planSave } from '../core/flow/save';
import type { SchemaValidator } from '../core/flow/schema';
import { applyEdits } from '../core/yaml/edits';
import { layoutLevel, shownPositions } from '../extension/autoLayout';

const MAX_BYTES = 2 * 1024 * 1024;
const SKIP = new Set(['node_modules', '.git', 'generated', 'out', 'dist', '.venv', 'venv', '.tox']);
const TIMEOUT_MS = 5000;

function git(cwd: string, args: string[]): Promise<string | undefined> {
  return new Promise((done) => {
    execFile(
      'git',
      args,
      { cwd, timeout: TIMEOUT_MS, windowsHide: true, maxBuffer: MAX_BYTES },
      (err, out) => done(err ? undefined : out),
    );
  });
}

const posix = (p: string) => p.split(sep).join('/');

function real(path: string): string {
  try {
    return realpathSync.native(path);
  } catch {
    return resolve(path);
  }
}

const inside = (root: string, path: string) => {
  const rel = relative(root, path);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
};

export class FsFlowIO implements FlowIO {
  private roots: string[];

  constructor(
    roots: string[],
    readonly schema: SchemaValidator,
    private readonly newId: IdFactory,
  ) {
    this.roots = roots.map(real);
  }

  setRoots(roots: string[]): void {
    if (roots.length > 0) this.roots = roots.map(real);
  }

  /** A path as tools show it: relative to its root (prefixed with the root's name when several). */
  private show(abs: string): string {
    const root = this.roots.find((r) => inside(r, abs)) ?? this.roots[0] ?? '';
    const rel = posix(relative(root, abs));
    return this.roots.length > 1 ? `${basename(root)}/${rel}` : rel;
  }

  /** The absolute file a tool means; refuses anything that is not a flow inside the roots. */
  private async locate(path: string, mustExist = true): Promise<string> {
    if (!path.endsWith('.flow.yaml')) throw new Error(`${path} is not a flow file (*.flow.yaml)`);
    const candidates = isAbsolute(path)
      ? [path]
      : this.roots.flatMap((r) => {
          const [first, ...rest] = path.split(/[\\/]/);
          return [
            join(r, path),
            ...(this.roots.length > 1 && first === basename(r) ? [join(r, ...rest)] : []),
          ];
        });
    for (const c of candidates) {
      // Symlinks are followed before the check, so a link cannot lead outside the roots.
      const target = real(c);
      if (!this.roots.some((r) => inside(r, target))) continue;
      try {
        if ((await fs.stat(target)).isFile()) return target;
      } catch {
        if (!mustExist && this.roots.some((r) => inside(r, real(dirname(c))))) return target;
      }
    }
    const within = candidates.some((c) => this.roots.some((r) => inside(r, real(c))));
    throw new Error(
      within
        ? `No flow ${path}; flow_list shows the flows`
        : `${path} is outside ${this.roots.map(posix).join(', ')}; only flows there can be used`,
    );
  }

  async list(): Promise<string[]> {
    const found: string[] = [];
    const walk = async (dir: string, depth: number) => {
      if (depth > 8 || found.length >= 500) return;
      let entries: import('node:fs').Dirent[];
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        if (e.isDirectory() && !SKIP.has(e.name) && !e.name.startsWith('.'))
          await walk(join(dir, e.name), depth + 1);
        else if (e.isFile() && e.name.endsWith('.flow.yaml'))
          found.push(this.show(join(dir, e.name)));
      }
    };
    for (const root of this.roots) await walk(root, 0);
    return found.sort();
  }

  async read(path: string): Promise<string> {
    const file = await this.locate(path);
    const stat = await fs.stat(file);
    if (stat.size > MAX_BYTES) throw new Error(`${path} is larger than 2 MB; not read`);
    return fs.readFile(file, 'utf8');
  }

  private async replace(file: string, text: string): Promise<void> {
    const tmp = `${file}.afd-${process.pid}.tmp`;
    await fs.writeFile(tmp, text, 'utf8');
    try {
      await fs.rename(tmp, file);
    } catch (e) {
      await fs.rm(tmp, { force: true });
      throw e;
    }
  }

  async write(path: string, before: string, after: string) {
    const file = await this.locate(path);
    if ((await fs.readFile(file, 'utf8')) !== before)
      throw new Error('the file changed while the tool worked; describe it again');
    const head = await git(dirname(file), ['show', `HEAD:./${basename(file)}`]);
    const plan = planSave(after, before, head ?? before);
    const text = applyEdits(after, plan.edits);
    await this.replace(file, text);
    return { text, notes: await this.generate(file, text) };
  }

  /** AFD-25: a .drawio or .svg export inside the roots (folders created); the shown path. */
  async writeExport(path: string, text: string): Promise<string> {
    if (!/\.(drawio|svg)$/i.test(path))
      throw new Error(`${path}: exports are .drawio or .svg files`);
    const target = isAbsolute(path) ? resolve(path) : resolve(this.roots[0] ?? '.', path);
    // The nearest existing folder decides, symlinks followed, so a link cannot lead outside.
    let dir = dirname(target);
    while (dir !== dirname(dir) && !(await fs.stat(dir).catch(() => undefined))) dir = dirname(dir);
    if (!this.roots.some((r) => inside(r, target) && inside(r, real(dir))))
      throw new Error(`${path} is outside ${this.roots.map(posix).join(', ')}`);
    await fs.mkdir(dirname(target), { recursive: true });
    await fs.writeFile(target, text, 'utf8');
    return this.show(target);
  }

  async create(path: string, text: string) {
    const file = await this.locate(path, false);
    try {
      await fs.stat(file);
      throw new Error(`${path} exists; edit it with flow_edit`);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
    await fs.mkdir(dirname(file), { recursive: true });
    await this.replace(file, text);
    return { text, notes: await this.generate(file, text) };
  }

  /** generated/ next to the flow, as the designer writes it on save (unless turned off). */
  private async generate(file: string, text: string): Promise<string[]> {
    const root = this.roots.find((r) => inside(r, file)) ?? dirname(file);
    if (!(await this.codegenOnSave(root)))
      return ['generated/ not updated (afd.codegen.onSave is off)'];
    const dir = join(dirname(file), 'generated');
    const plan = await planGenerated(
      text,
      this.schema,
      {
        read: (name) => fs.readFile(join(dir, name), 'utf8').catch(() => undefined),
        list: () => fs.readdir(dir).catch(() => []),
      },
      { source: basename(file), root: posix(relative(dir, root)) || '.' },
    );
    if (!plan.ok) return [`generated/ not updated: ${plan.error}`];
    if (plan.write.length) await fs.mkdir(dir, { recursive: true });
    for (const f of plan.write) await this.replace(join(dir, f.name), f.text);
    for (const name of plan.remove) await fs.rm(join(dir, name), { force: true });
    const parts = [
      plan.write.length ? `wrote ${plan.write.map((f) => f.name).join(', ')}` : '',
      plan.remove.length ? `removed ${plan.remove.join(', ')}` : '',
      plan.kept.length ? `kept ${plan.kept.join(', ')} (edited by hand)` : '',
    ].filter(Boolean);
    return parts.length ? [`generated/: ${parts.join('; ')}`] : [];
  }

  /** The workspace setting afd.codegen.onSave (.vscode/settings.json), default on. */
  private async codegenOnSave(root: string): Promise<boolean> {
    try {
      const tree = parseTree(await fs.readFile(join(root, '.vscode', 'settings.json'), 'utf8'));
      const node = tree && findNodeAtLocation(tree, ['afd.codegen.onSave']);
      return node ? getNodeValue(node) !== false : true;
    } catch {
      return true;
    }
  }

  ops(path: string): OpsContext {
    return {
      newId: this.newId,
      author: async () => {
        const root = this.roots.find((r) => inside(r, resolve(r, path))) ?? this.roots[0];
        return (await git(root ?? '.', ['config', 'user.name']))?.trim() || undefined;
      },
      layout: layoutLevel,
      positions: shownPositions,
    };
  }
}

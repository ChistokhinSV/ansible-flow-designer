// Flow files on disk for the MCP server (AFD-19). Only *.flow.yaml inside the roots (the client's
// MCP roots, else the working directory) are seen or written. A write acts like a save in the
// designer: tested nodes changed by the edit drop back, flow.version moves once against Git HEAD,
// and generated/ is refreshed without overwriting hand edits. Files are replaced atomically.

import { execFile } from 'node:child_process';
import { promises as fs, realpathSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { findNodeAtLocation, getNodeValue, parseTree } from 'jsonc-parser';
import type { FlowIO } from '../core/ai/handlers';
import type { OpsContext } from '../core/ai/ops';
import { isSourceFile, SKIP_DIRS, SOURCE_MAX_BYTES } from '../core/ai/sourceRules';
import { planGenerated } from '../core/engine/writePlan';
import { parseFlow } from '../core/flow/document';
import type { IdFactory } from '../core/flow/ids';
import { isFileKey } from '../core/flow/ids';
import { planSave } from '../core/flow/save';
import type { SchemaValidator } from '../core/flow/schema';
import type { SourceIO } from '../core/import/read';
import { resolveEnvironment, settingsFromJson } from '../core/run/environment';
import { followPaths, pathChanges } from '../core/scenario/follow';
import { parseScenarios, type ScenarioResult, scenariosFileName } from '../core/scenario/scenarios';
import { flowFacts } from '../core/view/flowFacts';
import { applyEdits } from '../core/yaml/edits';
import { type LayoutDirection, layoutLevel, shownPositions } from '../node/autoLayout';
import { canvasDirection, environmentSettings } from '../node/env/userSettings';
import { runScenarios } from '../node/scenario/runner';

const MAX_BYTES = SOURCE_MAX_BYTES;
const SKIP = new Set(SKIP_DIRS);
const TIMEOUT_MS = 5000;

/** What the tools answer when the server has no folder to work in (AFD-173). */
export const NO_ROOTS =
  'No folder to work in: the agent started the flow tools without saying which folder is open (no MCP roots), in the home folder or a drive root, which is not searched. Open the folder with the flows in the editor and start a new chat; or set AFD_MCP_ROOTS to that folder in the agent’s MCP config.';

/**
 * The folders the server works in until the client sends roots (AFD-172/173). AFD_MCP_ROOTS first
 * (an editor that did not resolve a variable such as ${workspaceFolder} leaves it out); else the
 * working directory, unless that is the home folder or a drive root: agents that send no roots
 * start servers there (Cursor), and walking it took 19 s and listed flows from other projects.
 */
export function startRoots(
  given: string | undefined,
  cwd: string,
  home: string,
  isDir: (path: string) => boolean,
): string[] {
  const listed = (given ?? '')
    .split(process.platform === 'win32' ? ';' : ':')
    .map((r) => r.trim())
    .filter((r) => r && !r.includes('${') && isAbsolute(r) && isDir(r));
  if (listed.length > 0) return listed;
  const here = resolve(cwd);
  const same = (a: string, b: string) =>
    process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
  if (same(here, resolve(home)) || dirname(here) === here) return [];
  return [here];
}

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

/**
 * AFD-137: the real path of `path`, or of its nearest ancestor that exists. A file that does not
 * exist yet is decided by the folder it would be written through, links followed.
 */
function nearestReal(path: string): string {
  for (let p = resolve(path); ; p = dirname(p)) {
    try {
      return realpathSync.native(p);
    } catch {
      if (dirname(p) === p) return p;
    }
  }
}

const inside = (root: string, path: string) => {
  const rel = relative(root, path);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
};

/**
 * One root's Ansible files, read-only, by repository path (AFD-27). Paths are resolved through
 * symlinks and must stay inside the root; only YAML, JSON and ansible.cfg are read, at most 2 MB.
 * Whether any other file exists (a template a task names) may be asked, never its content.
 */
export class FsSourceIO implements SourceIO {
  constructor(private readonly root: string) {}

  private within(path: string): string | undefined {
    const target = real(join(this.root, ...path.split('/').filter(Boolean)));
    return inside(this.root, target) ? target : undefined;
  }

  async read(path: string): Promise<string | undefined> {
    const file = this.within(path);
    if (!file || !isSourceFile(posix(file))) return undefined;
    try {
      const stat = await fs.stat(file);
      if (!stat.isFile() || stat.size > MAX_BYTES) return undefined;
      return await fs.readFile(file, 'utf8');
    } catch {
      return undefined;
    }
  }

  async list(dir: string): Promise<{ name: string; dir: boolean }[]> {
    const folder = this.within(dir);
    if (!folder) return [];
    try {
      const entries = await fs.readdir(folder, { withFileTypes: true });
      return entries
        .filter((e) => !(e.isDirectory() && SKIP.has(e.name)))
        .map((e) => ({ name: e.name, dir: e.isDirectory() }));
    } catch {
      return [];
    }
  }

  async exists(path: string): Promise<boolean> {
    const file = this.within(path);
    if (!file) return false;
    try {
      await fs.stat(file);
      return true;
    } catch {
      return false;
    }
  }
}

export class FsFlowIO implements FlowIO {
  private roots: string[];

  constructor(
    roots: string[],
    readonly schema: SchemaValidator,
    private readonly newId: IdFactory,
  ) {
    this.roots = roots.map(real);
  }

  /** AFD-173: no folder to work in (see startRoots): every tool says so instead of guessing. */
  private need(): void {
    if (this.roots.length === 0) throw new Error(NO_ROOTS);
  }

  setRoots(roots: string[]): void {
    if (roots.length > 0) this.roots = roots.map(real);
  }

  /** AFD-27: the Ansible files of the root a path names (by its name when there are several). */
  source(path: string): { io: SourceIO; path: string; prefix: string } | undefined {
    const parts = path.replaceAll('\\', '/').split('/');
    const named =
      this.roots.length > 1 ? this.roots.find((r) => basename(r) === parts[0]) : undefined;
    const root = named ?? this.roots[0];
    if (!root) return undefined;
    return {
      io: new FsSourceIO(root),
      path: named ? parts.slice(1).join('/') : path,
      prefix: named ? `${parts[0]}/` : this.roots.length > 1 ? `${basename(root)}/` : '',
    };
  }

  /** A path as tools show it: relative to its root (prefixed with the root's name when several). */
  /**
   * AFD-165: error text with the roots' absolute paths written as the tools write paths (relative,
   * or `<root>/…` with several roots) and the home folder as `~`, so a file system error does not
   * hand the client the machine's folder layout.
   */
  hidePaths(text: string): string {
    let out = text;
    const variants = (p: string) => [
      ...new Set([p, p.replaceAll('\\', '/'), p.replaceAll('/', '\\')]),
    ];
    for (const root of [...this.roots].sort((a, b) => b.length - a.length)) {
      const label = this.roots.length > 1 ? `${basename(root)}/` : '';
      for (const v of variants(root)) {
        out = out.replaceAll(`${v}\\`, label).replaceAll(`${v}/`, label);
        out = out.replaceAll(v, label ? label.slice(0, -1) : '.');
      }
    }
    for (const v of variants(homedir())) if (v.length > 1) out = out.replaceAll(v, '~');
    return out;
  }

  private show(abs: string): string {
    const root = this.roots.find((r) => inside(r, abs)) ?? this.roots[0] ?? '';
    const rel = posix(relative(root, abs));
    return this.roots.length > 1 ? `${basename(root)}/${rel}` : rel;
  }

  /** The absolute file a tool means; refuses anything that is not a flow inside the roots. */
  private async locate(path: string, mustExist = true): Promise<string> {
    this.need();
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
        // AFD-137: a missing parent is decided by its nearest existing ancestor, links followed.
        if (!mustExist && this.roots.some((r) => inside(r, nearestReal(dirname(c))))) return target;
      }
    }
    const within = candidates.some((c) => this.roots.some((r) => inside(r, nearestReal(c))));
    throw new Error(
      within
        ? `No flow ${path}; flow_list shows the flows`
        : `${path} is outside ${this.roots.map(posix).join(', ')}; only flows there can be used`,
    );
  }

  async list(): Promise<string[]> {
    this.need();
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
    const followed = await this.followScenarios(file, before, text);
    return { text, notes: [...followed, ...(await this.writeGenerated(file, text))] };
  }

  /** AFD-115: steps renamed or moved are renamed in the scenarios file next to the flow too. */
  private async followScenarios(file: string, before: string, after: string): Promise<string[]> {
    const was = parseFlow(before).doc;
    const now = parseFlow(after).doc;
    if (!was || !isFileKey(was.flow?.key) || !now) return [];
    const changes = pathChanges(was, now);
    if (changes.moved.size === 0) return [];
    const scenarios = join(dirname(file), scenariosFileName(was.flow.key));
    const current = await fs.readFile(scenarios, 'utf8').catch(() => undefined);
    const result = current === undefined ? undefined : followPaths(current, changes);
    if (!result) return [];
    await this.replace(scenarios, result.text);
    return [`Scenarios updated: ${result.notes.join(', ')}.`];
  }

  /** AFD-25: a .drawio or .svg export inside the roots (folders created); the shown path. */
  async writeExport(path: string, text: string): Promise<string> {
    if (!/\.(drawio|svg)$/i.test(path))
      throw new Error(`${path}: exports are .drawio or .svg files`);
    const target = isAbsolute(path) ? resolve(path) : resolve(this.roots[0] ?? '.', path);
    // The nearest existing folder decides, symlinks followed, so a link cannot lead outside.
    if (!this.roots.some((r) => inside(r, target) && inside(r, nearestReal(dirname(target)))))
      throw new Error(`${path} is outside ${this.roots.map(posix).join(', ')}`);
    // AFD-137: an existing link at the target would be written through.
    if ((await fs.lstat(target).catch(() => undefined))?.isSymbolicLink())
      throw new Error(`${path} is a link; export to another file name`);
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
    return { text, notes: await this.writeGenerated(file, text) };
  }

  /** AFD-191: generated/ from the flow as it is now, as a save writes it. */
  async generate(path: string): Promise<string[]> {
    const file = await this.locate(path);
    const notes = await this.writeGenerated(file, await fs.readFile(file, 'utf8'), true);
    return notes.length ? notes : ['generated/: already current'];
  }

  /** AFD-191: whether generated/ matches the flow (current, out of date, edited by hand, …). */
  async codeState(path: string): Promise<string | undefined> {
    const file = await this.locate(path);
    const dir = join(dirname(file), 'generated');
    const root = this.roots.find((r) => inside(r, file)) ?? dirname(file);
    const facts = await flowFacts(
      await fs.readFile(file, 'utf8'),
      this.schema,
      {
        read: (name) => fs.readFile(join(dir, name), 'utf8').catch(() => undefined),
        list: () => fs.readdir(dir).catch(() => []),
      },
      { source: basename(file), root: posix(relative(dir, root)) || '.' },
    );
    switch (facts.code) {
      case 'current':
        return 'current';
      case 'out of date':
        return 'out of date: run flow_edit with the regenerate op';
      case 'edited by hand':
        return `edited by hand (${facts.kept.join(', ')}): kept until you overwrite them`;
      case 'no code yet':
        return 'none yet: the regenerate op writes it';
      default:
        return 'blocked by errors: fix them and the code is written on the next edit';
    }
  }

  /** generated/ next to the flow, as the designer writes it on save (unless turned off). */
  private async writeGenerated(file: string, text: string, asked = false): Promise<string[]> {
    const root = this.roots.find((r) => inside(r, file)) ?? dirname(file);
    if (!asked && !(await this.codegenOnSave(root)))
      return ['generated/ not updated (afd.codegen.onSave is off)'];
    const dir = join(dirname(file), 'generated');
    // AFD-137: generated/ may be a link only to a folder inside the roots.
    if (!this.roots.some((r) => inside(r, nearestReal(dir))))
      return ['generated/ not updated: it leads outside the workspace'];
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
  /** AFD-117: the scenarios file next to a flow, or undefined when there is none. */
  async readScenarios(path: string, key: string): Promise<string | undefined> {
    const file = await this.locate(path);
    return fs.readFile(join(dirname(file), scenariosFileName(key)), 'utf8').catch(() => undefined);
  }

  async writeScenarios(
    path: string,
    key: string,
    before: string | undefined,
    after: string,
  ): Promise<string[]> {
    const file = await this.locate(path);
    const target = join(dirname(file), scenariosFileName(key));
    const now = await fs.readFile(target, 'utf8').catch(() => undefined);
    if (now !== before)
      throw new Error('the scenarios file changed while the tool worked; list them again');
    await this.replace(target, after);
    return [`Wrote ${this.show(target)}.`];
  }

  /**
   * AFD-117: the scenarios in Ansible, with the CLI's runner; each scenario at most 3 minutes.
   * AFD-126: in the environment of the user's VS Code settings. The workspace's
   * .vscode/settings.json is repository content and applies only with
   * AFD_MCP_WORKSPACE_ENVIRONMENT=1, as VS Code applies it only in a trusted workspace.
   */
  async verifyScenarios(path: string, names?: string[]): Promise<ScenarioResult[] | string> {
    const file = await this.locate(path);
    const root = this.roots.find((r) => inside(r, file)) ?? dirname(file);
    const settings = await environmentSettings(root);
    const { afd, redhat } = settingsFromJson(settings.json);
    const env = resolveEnvironment(afd, redhat, process.platform);
    if (!env.ok) {
      const ignored = settings.ignoredWorkspace
        ? ` ${this.show(join(root, '.vscode', 'settings.json'))} sets one, which the server uses only when started with AFD_MCP_WORKSPACE_ENVIRONMENT=1.`
        : '';
      return `No Ansible environment to run in: ${env.error}. Set afd.environment.* in your VS Code user settings (Set Up Ansible Environment… does it).${ignored} Or run them with Run Scenarios in VS Code.`;
    }
    const doc = parseFlow(await fs.readFile(file, 'utf8')).doc;
    if (!doc?.flow?.key) return 'The flow does not read';
    if (!isFileKey(doc.flow.key)) return 'The flow key is not a lowercase slug: fix it first';
    const parsed = parseScenarios(
      (await fs
        .readFile(join(dirname(file), scenariosFileName(doc.flow.key)), 'utf8')
        .catch(() => '')) || '',
    );
    if (!parsed.file) return parsed.error ?? 'No scenarios';
    const work = await fs.mkdtemp(join(tmpdir(), 'afd-mcp-scenarios-'));
    try {
      return await runScenarios({
        env: env.env,
        root,
        probeDir: join(__dirname, 'probe'),
        flowFile: file,
        doc,
        file: parsed.file,
        workDir: work,
        only: names,
        timeoutMs: 180_000,
      });
    } finally {
      await fs.rm(work, { recursive: true, force: true });
    }
  }

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
    const root = () => this.roots.find((r) => inside(r, resolve(r, path))) ?? this.roots[0];
    // AFD-192: lay out as the canvas does, in the user's afd.canvas.direction.
    let direction: Promise<LayoutDirection> | undefined;
    const dir = () => {
      direction ??= canvasDirection(root() ?? '.');
      return direction;
    };
    return {
      newId: this.newId,
      author: async () => (await git(root() ?? '.', ['config', 'user.name']))?.trim() || undefined,
      layout: async (level) => layoutLevel(level, await dir()),
      positions: async (model) => shownPositions(model, await dir()),
    };
  }
}

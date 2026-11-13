// AFD-258, AFD-261: the files of an inventory, read through a small file interface so the
// Inventory view (VS Code's files) and the agents' tool in the MCP server (Node's) find the same
// sources, the same variables files and the same places for new ones. Pure apart from that
// interface.
import { fileVars, type InventoryFile, inlineVars, isVaultFile, type VarEntry } from './edit';
import {
  defaultInventory,
  type InventoryProblem,
  ignoredInFolder,
  isStatic,
  type OriginEntry,
  OriginIndex,
  type SourceKind,
  sourceEntries,
  sourceKind,
  sourceProblems,
} from './origins';

/** Files of one repository, by path from its root (`/` separated). */
export interface InventoryFs {
  /** The text; undefined when it is not there, not readable, or over the size limit. */
  read(path: string): Promise<string | undefined>;
  /** The entries of a folder, sorted; undefined when it is not a folder. */
  list(path: string): Promise<{ name: string; dir: boolean }[] | undefined>;
  kind(path: string): Promise<'file' | 'dir' | undefined>;
}

export interface SourceInfo {
  /** As shown: relative to the root. */
  path: string;
  /** `missing`: named but not there. `outside`: not in the repository, so not read. */
  kind: SourceKind | 'missing' | 'outside';
}

/** A file of variables for one host or one group. */
export interface VarFile {
  of: 'host' | 'group';
  name: string;
  path: string;
  text: string;
}

export interface InventoryData {
  /** What was asked for: the setting, or what ansible.cfg names. */
  named: string[];
  sources: SourceInfo[];
  entries: OriginEntry[];
  /** AFD-262: what Ansible will refuse in the static files, with the line. */
  problems: InventoryProblem[];
  /** The static sources with their text: what the edits work on. */
  texts: InventoryFile[];
  varFiles: VarFile[];
  /**
   * The `host_vars/` and `group_vars/` folders there are (beside a source first, then at the
   * root), and where one would be made: beside the first source.
   */
  varDirs: { host?: string; group?: string; base: string };
}

const MAX_FILES = 200;
const join = (base: string, name: string) => (base ? `${base}/${name}` : name);

async function filesUnder(fs: InventoryFs, dir: string, depth: number, out: string[]) {
  if (depth > 4 || out.length >= MAX_FILES) return;
  for (const entry of (await fs.list(dir)) ?? []) {
    const path = `${dir}/${entry.name}`;
    if (ignoredInFolder(path)) continue;
    if (entry.dir) await filesUnder(fs, path, depth + 1, out);
    else if (out.length < MAX_FILES) out.push(path);
  }
}

const VARS_NAME = /\.(ya?ml|json)$|^[^.]+$/i;

/** The variables files of one `host_vars/` or `group_vars/` folder. */
async function varFilesIn(fs: InventoryFs, dir: string, of: VarFile['of'], out: VarFile[]) {
  const read = async (path: string, name: string) => {
    if (out.length >= MAX_FILES || !VARS_NAME.test(path.split('/').at(-1) ?? '')) return;
    const text = await fs.read(path);
    if (text !== undefined) out.push({ of, name, path, text });
  };
  for (const entry of (await fs.list(dir)) ?? []) {
    if (entry.name.startsWith('.')) continue;
    // group_vars/<name>/*.yml: every file there is that name's.
    if (entry.dir) {
      for (const inner of (await fs.list(`${dir}/${entry.name}`)) ?? [])
        if (!inner.dir) await read(`${dir}/${entry.name}/${inner.name}`, entry.name);
    } else await read(`${dir}/${entry.name}`, entry.name.replace(/\.(ya?ml|json)$/i, ''));
  }
}

/**
 * The inventory a repository uses: `setting` (afd.run.inventory) when set, else what its
 * ansible.cfg names. A folder is its files, as Ansible reads a directory inventory.
 */
export async function readInventory(fs: InventoryFs, setting: string): Promise<InventoryData> {
  const named = setting ? [setting] : defaultInventory((await fs.read('ansible.cfg')) ?? '');
  const sources: SourceInfo[] = [];
  const entries: OriginEntry[] = [];
  const problems: InventoryProblem[] = [];
  const texts: InventoryFile[] = [];
  /** Folders that may hold host_vars/ and group_vars/: where each source is, then the root. */
  const bases: string[] = [];
  for (const raw of named) {
    const path = raw.split('\\').join('/').replace(/^\.\//, '').replace(/\/+$/, '');
    if (!path || path.startsWith('/') || path.startsWith('~') || path.split('/').includes('..')) {
      sources.push({ path: raw, kind: 'outside' });
      continue;
    }
    const kind = await fs.kind(path);
    if (!kind) {
      sources.push({ path, kind: 'missing' });
      continue;
    }
    const files: string[] = [];
    if (kind === 'dir') {
      await filesUnder(fs, path, 0, files);
      bases.push(path);
    } else {
      files.push(path);
      bases.push(path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');
    }
    for (const file of files) {
      const body = await fs.read(file);
      // Too large to read: listed by its name, not searched and not edited.
      const what = sourceKind(file, body ?? '');
      sources.push({ path: file, kind: what });
      if (body === undefined) continue;
      entries.push(...sourceEntries(file, body, what));
      problems.push(...sourceProblems(file, body, what));
      if (isStatic(what)) texts.push({ path: file, kind: what, text: body });
    }
  }
  const places = [...new Set([...bases, ''])];
  const varFiles: VarFile[] = [];
  const varDirs: InventoryData['varDirs'] = { base: places[0] ?? '' };
  for (const base of places)
    for (const of of ['host', 'group'] as const) {
      const dir = join(base, `${of}_vars`);
      await varFilesIn(fs, dir, of, varFiles);
      if (!varDirs[of] && (await fs.kind(dir)) === 'dir') varDirs[of] = dir;
    }
  return { named, sources, entries, problems, texts, varFiles, varDirs };
}

export interface ShownVar extends VarEntry {
  /** Written in the inventory file itself, not in a variables file. */
  inline: boolean;
}

type Target = { host?: string; group?: string };

/** A host's or a group's own variables, the inventory file's first, then its variables files'. */
export function targetVars(
  files: Pick<InventoryData, 'texts' | 'varFiles'>,
  target: Target,
): ShownVar[] {
  const out: ShownVar[] = inlineVars(files.texts, target).map((v) => ({ ...v, inline: true }));
  const of = target.host ? 'host' : 'group';
  const name = target.host ?? target.group;
  for (const f of files.varFiles)
    if (f.of === of && f.name === name)
      for (const v of fileVars(f.path, f.text)) out.push({ ...v, inline: false });
  return out;
}

/** The variables files of a target that can be written to (not vault-encrypted). */
export function writableVarFiles(
  files: Pick<InventoryData, 'varFiles'>,
  target: Target,
): VarFile[] {
  const of = target.host ? 'host' : 'group';
  const name = target.host ?? target.group;
  return files.varFiles.filter((f) => f.of === of && f.name === name && !isVaultFile(f.text));
}

export type VarPlace =
  | { inline: true }
  /** `text` undefined: the file is new. */
  | { file: string; text?: string };

/**
 * Where a new variable of a host or a group goes (the product owner's rule): the variables folder
 * when the repository has one, the inventory file otherwise. `ask` when the target already has
 * variables in the inventory file and a variables folder is there too: both are in use.
 */
export function varPlace(
  data: Pick<InventoryData, 'texts' | 'varFiles' | 'varDirs' | 'entries'>,
  target: Target,
): VarPlace | { ask: [VarPlace & { file: string }, { inline: true }] } {
  const of = target.host ? 'host' : 'group';
  const name = (target.host ?? target.group) as string;
  const index = new OriginIndex(data.entries);
  const existing = writableVarFiles(data, target)[0];
  const dir = data.varDirs[of];
  const origin = target.host ? index.host(name) : index.group(name);
  const written = !!origin && !origin.range;
  const base = data.varDirs.base ? `${data.varDirs.base}/` : '';
  const inFile = existing
    ? { file: existing.path, text: existing.text }
    : { file: `${dir ?? `${base}${of}_vars`}/${name}.yml` };
  // Not written as a plain name in a file (a dynamic source, a range): only a variables file can
  // hold its variables.
  if (!written) return inFile;
  if (!dir && !existing) return { inline: true };
  return targetVars(data, target).some((v) => v.inline)
    ? { ask: [inFile, { inline: true }] }
    : inFile;
}

/** The variables files to rename with a host or a group: `<name>.yml`, or the folder `<name>/`. */
export function varRenames(
  data: Pick<InventoryData, 'varFiles'>,
  of: 'host' | 'group',
  from: string,
  to: string,
): [string, string][] {
  const out = new Map<string, string>();
  for (const f of data.varFiles) {
    if (f.of !== of || f.name !== from) continue;
    const dir = f.path.slice(0, f.path.lastIndexOf('/'));
    // In the folder <name>/: the folder is renamed once, not each file.
    if (dir.endsWith(`/${from}`)) out.set(dir, `${dir.slice(0, -from.length)}${to}`);
    else out.set(f.path, `${dir}/${to}${f.path.slice(dir.length + 1 + from.length)}`);
  }
  return [...out];
}

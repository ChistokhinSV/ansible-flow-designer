// AFD-258: the files of the inventory in use, read from the workspace (not through the Ansible
// environment: these are the files the user edits), with where each host and group is written.
// AFD-260: and the variables files beside them (host_vars/, group_vars/).
import * as vscode from 'vscode';
import {
  fileVars,
  type InventoryFile,
  inlineVars,
  isVaultFile,
  type VarEntry,
} from '../core/inventory/edit';
import {
  defaultInventory,
  ignoredInFolder,
  isStatic,
  type OriginEntry,
  OriginIndex,
  type SourceKind,
  sourceEntries,
  sourceKind,
} from '../core/inventory/origins';

export interface SourceFile {
  /** Relative to the workspace folder, as shown. */
  path: string;
  /** `missing`: named but not there. `outside`: not in the workspace folder, so not read. */
  kind: SourceKind | 'missing' | 'outside';
  uri?: vscode.Uri;
}

/** A file of variables for one host or one group. */
export interface VarFile {
  of: 'host' | 'group';
  name: string;
  path: string;
  text: string;
}

export interface InventoryFiles {
  sources: SourceFile[];
  index: OriginIndex;
  /** The static sources with their text: what the edits work on. */
  texts: InventoryFile[];
  varFiles: VarFile[];
  /**
   * The `host_vars/` and `group_vars/` folders there are (beside a source first, then at the
   * root), and where one would be made: beside the first source.
   */
  varDirs: { host?: string; group?: string; base: string };
}

/** A file larger than this is listed but not searched for hosts. */
const MAX_BYTES = 2 * 1024 * 1024;
const MAX_FILES = 200;

async function filesUnder(dir: vscode.Uri, rel: string, depth: number, out: string[]) {
  if (depth > 4 || out.length >= MAX_FILES) return;
  const entries = await vscode.workspace.fs.readDirectory(dir);
  for (const [name, type] of entries.sort(([a], [b]) => a.localeCompare(b))) {
    const path = `${rel}/${name}`;
    if (ignoredInFolder(path)) continue;
    if (type & vscode.FileType.Directory)
      await filesUnder(vscode.Uri.joinPath(dir, name), path, depth + 1, out);
    else if (out.length < MAX_FILES) out.push(path);
  }
}

const decode = async (uri: vscode.Uri) =>
  new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));

const join = (base: string, name: string) => (base ? `${base}/${name}` : name);

/** The variables files of one `host_vars/` or `group_vars/` folder. */
async function varFilesIn(
  folder: vscode.Uri,
  dir: string,
  of: VarFile['of'],
  out: VarFile[],
): Promise<void> {
  const read = async (path: string, name: string) => {
    if (out.length >= MAX_FILES || !/\.(ya?ml|json)$|^[^.]+$/i.test(path.split('/').at(-1) ?? ''))
      return;
    try {
      const at = vscode.Uri.joinPath(folder, path);
      if ((await vscode.workspace.fs.stat(at)).size > MAX_BYTES) return;
      out.push({ of, name, path, text: await decode(at) });
    } catch {
      // Unreadable: not shown.
    }
  };
  let entries: [string, vscode.FileType][];
  try {
    entries = await vscode.workspace.fs.readDirectory(vscode.Uri.joinPath(folder, dir));
  } catch {
    return;
  }
  for (const [name, type] of entries.sort(([a], [b]) => a.localeCompare(b))) {
    if (name.startsWith('.')) continue;
    if (type & vscode.FileType.Directory) {
      // group_vars/<name>/*.yml: every file there is that name's.
      const inner = await vscode.workspace.fs
        .readDirectory(vscode.Uri.joinPath(folder, dir, name))
        .then(
          (x) => x,
          () => [] as [string, vscode.FileType][],
        );
      for (const [file, t] of inner.sort(([a], [b]) => a.localeCompare(b)))
        if (t & vscode.FileType.File) await read(`${dir}/${name}/${file}`, name);
    } else await read(`${dir}/${name}`, name.replace(/\.(ya?ml|json)$/i, ''));
  }
}

/**
 * The sources of the inventory: `afd.run.inventory` when set, else what the repository's
 * ansible.cfg names. A folder is its files, as Ansible reads a directory inventory.
 */
export async function readInventoryFiles(
  folder: vscode.Uri,
  setting: string,
): Promise<InventoryFiles> {
  let named = setting ? [setting] : [];
  if (!setting)
    try {
      named = defaultInventory(await decode(vscode.Uri.joinPath(folder, 'ansible.cfg')));
    } catch {
      // No ansible.cfg here: Ansible's own default, which is not in the repository.
    }
  const sources: SourceFile[] = [];
  const entries: OriginEntry[] = [];
  const texts: InventoryFile[] = [];
  /** Folders that may hold host_vars/ and group_vars/: where each source is, then the root. */
  const bases: string[] = [];
  for (const raw of named) {
    const path = raw.split('\\').join('/').replace(/^\.\//, '').replace(/\/+$/, '');
    if (!path || path.startsWith('/') || path.startsWith('~') || path.split('/').includes('..')) {
      sources.push({ path: raw, kind: 'outside' });
      continue;
    }
    const uri = vscode.Uri.joinPath(folder, path);
    let stat: vscode.FileStat;
    try {
      stat = await vscode.workspace.fs.stat(uri);
    } catch {
      sources.push({ path, kind: 'missing' });
      continue;
    }
    const files: string[] = [];
    if (stat.type & vscode.FileType.Directory) {
      await filesUnder(uri, path, 0, files);
      bases.push(path);
    } else {
      files.push(path);
      bases.push(path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');
    }
    for (const file of files) {
      const at = vscode.Uri.joinPath(folder, file);
      try {
        const size = (await vscode.workspace.fs.stat(at)).size;
        const body = size > MAX_BYTES ? '' : await decode(at);
        const kind = sourceKind(file, body);
        sources.push({ path: file, kind, uri: at });
        entries.push(...sourceEntries(file, body, kind));
        if (isStatic(kind) && size <= MAX_BYTES) texts.push({ path: file, kind, text: body });
      } catch {
        sources.push({ path: file, kind: 'missing' });
      }
    }
  }
  const places = [...new Set([...bases, ''])];
  const varFiles: VarFile[] = [];
  const varDirs: InventoryFiles['varDirs'] = { base: places[0] ?? '' };
  for (const base of places)
    for (const of of ['host', 'group'] as const) {
      const dir = join(base, `${of}_vars`);
      const before = varFiles.length;
      await varFilesIn(folder, dir, of, varFiles);
      const there =
        varFiles.length > before ||
        (await vscode.workspace.fs.stat(vscode.Uri.joinPath(folder, dir)).then(
          (s) => !!(s.type & vscode.FileType.Directory),
          () => false,
        ));
      if (there && !varDirs[of]) varDirs[of] = dir;
    }
  return { sources, index: new OriginIndex(entries), texts, varFiles, varDirs };
}

export interface ShownVar extends VarEntry {
  /** Written in the inventory file itself, not in a variables file. */
  inline: boolean;
}

/** A host's or a group's own variables, the inventory file's first, then its variables files'. */
export function targetVars(
  files: InventoryFiles,
  target: { host?: string; group?: string },
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
  files: InventoryFiles,
  target: { host?: string; group?: string },
): VarFile[] {
  const of = target.host ? 'host' : 'group';
  const name = target.host ?? target.group;
  return files.varFiles.filter((f) => f.of === of && f.name === name && !isVaultFile(f.text));
}

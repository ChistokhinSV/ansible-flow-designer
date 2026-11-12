// AFD-258: the files of the inventory in use, read from the workspace (not through the Ansible
// environment: these are the files the user edits), with where each host and group is written.
import * as vscode from 'vscode';
import {
  defaultInventory,
  ignoredInFolder,
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

export interface InventoryFiles {
  sources: SourceFile[];
  index: OriginIndex;
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

/**
 * The sources of the inventory: `afd.run.inventory` when set, else what the repository's
 * ansible.cfg names. A folder is its files, as Ansible reads a directory inventory.
 */
export async function readInventoryFiles(
  folder: vscode.Uri,
  setting: string,
): Promise<InventoryFiles> {
  const text = async (uri: vscode.Uri) =>
    new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
  let named = setting ? [setting] : [];
  if (!setting)
    try {
      named = defaultInventory(await text(vscode.Uri.joinPath(folder, 'ansible.cfg')));
    } catch {
      // No ansible.cfg here: Ansible's own default, which is not in the repository.
    }
  const sources: SourceFile[] = [];
  const entries: OriginEntry[] = [];
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
    if (stat.type & vscode.FileType.Directory) await filesUnder(uri, path, 0, files);
    else files.push(path);
    for (const file of files) {
      const at = vscode.Uri.joinPath(folder, file);
      try {
        const size = (await vscode.workspace.fs.stat(at)).size;
        const body = size > MAX_BYTES ? '' : await text(at);
        const kind = sourceKind(file, body);
        sources.push({ path: file, kind, uri: at });
        entries.push(...sourceEntries(file, body, kind));
      } catch {
        sources.push({ path: file, kind: 'missing' });
      }
    }
  }
  return { sources, index: new OriginIndex(entries) };
}

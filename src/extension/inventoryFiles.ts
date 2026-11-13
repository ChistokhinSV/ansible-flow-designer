// AFD-258: the files of the inventory in use, read from the workspace (not through the Ansible
// environment: these are the files the user edits), with where each host and group is written.
// AFD-260: and the variables files beside them (host_vars/, group_vars/). The reading itself is
// core/inventory/files, shared with the agents' tool; here it gets VS Code's file system.
import * as vscode from 'vscode';
import {
  type InventoryData,
  type InventoryFs,
  readInventory,
  type SourceInfo,
} from '../core/inventory/files';
import { OriginIndex } from '../core/inventory/origins';

export {
  type ShownVar,
  targetVars,
  type VarFile,
  varPlace,
  varRenames,
  writableVarFiles,
} from '../core/inventory/files';

export interface SourceFile extends SourceInfo {
  uri?: vscode.Uri;
}

export interface InventoryFiles extends Omit<InventoryData, 'sources'> {
  sources: SourceFile[];
  index: OriginIndex;
}

/** A file larger than this is listed but not searched for hosts. */
const MAX_BYTES = 2 * 1024 * 1024;

/** A workspace folder's files, by path from it. */
export function workspaceFs(folder: vscode.Uri): InventoryFs {
  const at = (path: string) => (path ? vscode.Uri.joinPath(folder, path) : folder);
  return {
    async read(path) {
      try {
        if ((await vscode.workspace.fs.stat(at(path))).size > MAX_BYTES) return undefined;
        return new TextDecoder().decode(await vscode.workspace.fs.readFile(at(path)));
      } catch {
        return undefined;
      }
    },
    async list(path) {
      try {
        const entries = await vscode.workspace.fs.readDirectory(at(path));
        return entries
          .map(([name, type]) => ({ name, dir: !!(type & vscode.FileType.Directory) }))
          .sort((a, b) => a.name.localeCompare(b.name));
      } catch {
        return undefined;
      }
    },
    async kind(path) {
      try {
        const type = (await vscode.workspace.fs.stat(at(path))).type;
        return type & vscode.FileType.Directory ? 'dir' : 'file';
      } catch {
        return undefined;
      }
    },
  };
}

/**
 * The sources of the inventory: `afd.run.inventory` when set, else what the repository's
 * ansible.cfg names.
 */
export async function readInventoryFiles(
  folder: vscode.Uri,
  setting: string,
): Promise<InventoryFiles> {
  const data = await readInventory(workspaceFs(folder), setting);
  return {
    ...data,
    sources: data.sources.map((s) =>
      s.kind === 'missing' || s.kind === 'outside'
        ? s
        : { ...s, uri: vscode.Uri.joinPath(folder, s.path) },
    ),
    index: new OriginIndex(data.entries),
  };
}

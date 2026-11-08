// What every import command shares (M9, AFD-26): the target repository, the flow key, files read
// from the workspace, writing the new flow, and the message that announces it.
import { realpath } from 'node:fs/promises';
import { dirname, isAbsolute, relative as relativePath } from 'node:path';
import * as vscode from 'vscode';
import { SLUG, slugify, uniqueKey } from '../../core/flow/ids';
import { normalize, type SourceIO } from '../../core/import/read';
import type { ImportResult } from '../../core/import/result';

export async function exists(uri: vscode.Uri): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(uri);
    return true;
  } catch {
    return false;
  }
}

export async function pickFolder(given?: vscode.Uri): Promise<vscode.WorkspaceFolder | undefined> {
  if (given) return vscode.workspace.getWorkspaceFolder(given);
  const folders = vscode.workspace.workspaceFolders ?? [];
  return folders.length > 1
    ? vscode.window.showWorkspaceFolderPick({ placeHolder: 'Repository for the imported flow' })
    : folders[0];
}

export const flowDir = (folder: vscode.WorkspaceFolder, key: string) =>
  vscode.Uri.joinPath(folder.uri, 'flows', key);

/** Asks for the flow key (the folder under flows/); an existing folder is refused. */
export async function askKey(
  folder: vscode.WorkspaceFolder,
  title: string,
  suggested: string,
): Promise<string | undefined> {
  return vscode.window.showInputBox({
    title,
    prompt: 'Flow key (the folder under flows/)',
    value: slugify(suggested, 'imported'),
    validateInput: async (v) =>
      !SLUG.test(v)
        ? 'Lowercase letters, digits and dashes'
        : (await exists(flowDir(folder, v)))
          ? `flows/${v} already exists`
          : undefined,
  });
}

/** Keys for several imports at once: each name's slug, made unique against flows/ and each other. */
export async function freeKeys(folder: vscode.WorkspaceFolder, names: string[]): Promise<string[]> {
  const taken = new Set<string>();
  try {
    for (const [name] of await vscode.workspace.fs.readDirectory(
      vscode.Uri.joinPath(folder.uri, 'flows'),
    ))
      taken.add(name);
  } catch {}
  return names.map((n) => {
    const key = uniqueKey(slugify(n, 'imported'), taken);
    taken.add(key);
    return key;
  });
}

/**
 * Whether a workspace path stays inside the folder once links are resolved (AFD-136). A path
 * that does not exist yet counts by its nearest existing parent.
 */
export async function stillInside(folder: vscode.WorkspaceFolder, path: string): Promise<boolean> {
  const uri = vscode.Uri.joinPath(folder.uri, ...path.split('/').filter(Boolean));
  if (uri.scheme !== 'file') return true;
  const real = async (p: string): Promise<string> => {
    for (let at = p; ; at = dirname(at)) {
      try {
        return await realpath(at);
      } catch {
        if (dirname(at) === at) return at;
      }
    }
  };
  const [root, file] = await Promise.all([real(folder.uri.fsPath), real(uri.fsPath)]);
  const rel = relativePath(root, file);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/** A playbook, vars file or role file an import reads whole: anything bigger is not one. */
const IMPORT_MAX_BYTES = 2 * 1024 * 1024;

/**
 * The workspace folder's files as an import reads them (repository paths, forward slashes).
 * AFD-136: include_tasks, vars_files, role names and AWX playbook paths come from the files being
 * imported, so every path must stay inside the folder (`..` and links leading out are refused)
 * and a file is read only up to IMPORT_MAX_BYTES.
 */
export function workspaceSource(folder: vscode.WorkspaceFolder): SourceIO {
  const uri = (path: string) => vscode.Uri.joinPath(folder.uri, ...path.split('/').filter(Boolean));
  const allowed = async (path: string) =>
    !normalize(path).startsWith('..') && (await stillInside(folder, path));
  return {
    async read(path) {
      if (!(await allowed(path))) return undefined;
      try {
        // Open editors win, so an unsaved playbook imports as shown.
        const open = vscode.workspace.textDocuments.find(
          (d) => d.uri.toString() === uri(path).toString(),
        );
        if (open) return open.getText();
        if ((await vscode.workspace.fs.stat(uri(path))).size > IMPORT_MAX_BYTES) return undefined;
        return new TextDecoder().decode(await vscode.workspace.fs.readFile(uri(path)));
      } catch {
        return undefined;
      }
    },
    async list(dir) {
      if (!(await allowed(dir))) return [];
      try {
        return (await vscode.workspace.fs.readDirectory(uri(dir))).map(([name, type]) => ({
          name,
          dir: (type & vscode.FileType.Directory) !== 0,
        }));
      } catch {
        return [];
      }
    },
    exists: async (path) => (await allowed(path)) && exists(uri(path)),
  };
}

export interface ImportSummary {
  uris: vscode.Uri[];
  notes: string[];
  counts?: ImportResult['counts'];
}

/** "Imported flows/x/x.flow.yaml: 21 step(s), ..." with the notes one click away. */
export async function announceImport(outcome: ImportSummary): Promise<void> {
  const c = outcome.counts;
  const what =
    outcome.uris.length === 1
      ? vscode.workspace.asRelativePath(outcome.uris[0] as vscode.Uri)
      : `${outcome.uris.length} flows`;
  const text = `Imported ${what}: ${c?.steps ?? 0} step(s), ${c?.implemented ?? 0} ready to run, ${c?.drafts ?? 0} to check.`;
  const show = outcome.notes.length ? 'Show notes' : undefined;
  const pick = await vscode.window.showInformationMessage(text, ...(show ? [show] : []));
  if (pick === show)
    await vscode.window.showQuickPick(outcome.notes, {
      title: 'What the import could not map one to one',
      canPickMany: false,
    });
}

/** Counts of several imports, added up. */
export function addCounts(all: ImportResult['counts'][]): ImportResult['counts'] {
  return all.reduce(
    (a, c) => ({
      steps: a.steps + c.steps,
      implemented: a.implemented + c.implemented,
      drafts: a.drafts + c.drafts,
    }),
    { steps: 0, implemented: 0, drafts: 0 },
  );
}

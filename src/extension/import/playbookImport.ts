// Import Ansible Playbooks (AFD-26, ADR-0021): a playbook, or the playbooks of a folder, become new
// flows at flows/<key>/<key>.flow.yaml, one step per task, and the first opens in the designer.
// A one-time copy: the playbooks are only read. Like a new flow (AFD-23), the file stores no
// positions; the canvas lays the levels out.
import * as vscode from 'vscode';
import { flowText } from '../../core/awx/import';
import type { IdFactory } from '../../core/flow/ids';
import { importPlaybook } from '../../core/import/playbook';
import { importPrompt } from '../../core/import/prompt';
import { basename, normalize } from '../../core/import/read';
import type { ImportResult } from '../../core/import/result';
import { readPlaybook, scanFolder } from '../../core/import/source';
import { type AiStart, type ImportMode, pickMode, startAiImport } from './aiStart';
import {
  addCounts,
  askKey,
  exists,
  flowDir,
  freeKeys,
  type ImportSummary,
  workspaceSource,
} from './common';

/** What tests pass instead of picking (every field optional: a missing one is asked for). */
export interface PlaybookImportRequest {
  /** A playbook or a folder inside a workspace folder. */
  source?: vscode.Uri;
  /** Repository paths of the playbooks to import, for a folder. */
  playbooks?: string[];
  /** Flow keys, one per playbook. */
  keys?: string[];
  /** AFD-27: as is (default when given by tests), or with an AI assistant. */
  mode?: ImportMode;
  /** AFD-27: where the AI prompt goes (asked when absent). */
  via?: 'chat' | 'clipboard';
}

export interface PlaybookImportOutcome extends ImportSummary {
  error?: string;
  /** AFD-27: the prompt handed to the AI assistant, and where it went. */
  prompt?: string;
  started?: AiStart;
}

export interface PlaybookImportDeps {
  newId: IdFactory;
  /** Short module name → FQCN from the folder's catalog, when one is loaded. */
  resolveModule?(
    folder: vscode.WorkspaceFolder,
  ): ((name: string, collections: string[]) => string | undefined) | undefined;
}

const fail = (error: string): PlaybookImportOutcome => ({ uris: [], notes: [], error });

export async function importPlaybooks(
  deps: PlaybookImportDeps,
  request: PlaybookImportRequest = {},
): Promise<PlaybookImportOutcome> {
  const source =
    request.source ??
    (
      await vscode.window.showOpenDialog({
        title: 'Playbook, or a folder of playbooks, to import',
        canSelectFiles: true,
        canSelectFolders: true,
        canSelectMany: false,
        filters: { 'Ansible playbooks': ['yml', 'yaml'] },
      })
    )?.[0];
  if (!source) return fail('Cancelled');
  const folder = vscode.workspace.getWorkspaceFolder(source);
  if (!folder) return fail('Open the repository with the playbooks as a workspace folder first.');
  const io = workspaceSource(folder);
  const path = normalize(vscode.workspace.asRelativePath(source, false).replaceAll('\\', '/'));
  const rel = source.toString() === folder.uri.toString() ? '' : path;
  const isDir = ((await vscode.workspace.fs.stat(source)).type & vscode.FileType.Directory) !== 0;

  let playbooks = request.playbooks;
  if (!playbooks) {
    if (!isDir) playbooks = [rel];
    else {
      const scan = await scanFolder(io, rel);
      if (!scan.playbooks.length) return fail(`No playbooks in ${rel || folder.name}.`);
      const picks = await vscode.window.showQuickPick(
        scan.playbooks.map((p) => ({
          label: p.path,
          description: p.title,
          detail: p.importedBy ? `imported by ${p.importedBy}` : undefined,
          picked: p.entry,
          path: p.path,
        })),
        {
          title: 'Import Ansible Playbooks',
          placeHolder: 'Playbooks to import, one flow each (top-level ones are selected)',
          canPickMany: true,
        },
      );
      if (!picks?.length) return fail('Cancelled');
      playbooks = picks.map((p) => p.path);
    }
  }

  const what = playbooks.length === 1 ? (playbooks[0] as string) : `${playbooks.length} playbooks`;
  const mode = request.mode ?? (await pickMode(what));
  if (!mode) return fail('Cancelled');
  const names = playbooks.map((p) => basename(p).replace(/\.ya?ml$/, ''));
  let keys = request.keys;
  if (!keys) {
    if (playbooks.length === 1) {
      const key = await askKey(folder, `Import ${playbooks[0]}`, names[0] as string);
      if (!key) return fail('Cancelled');
      keys = [key];
    } else keys = await freeKeys(folder, names);
  }

  if (mode === 'ai') {
    // The assistant writes the flows; the command only checks the keys and hands over the prompt.
    for (const key of keys)
      if (await exists(flowDir(folder, key))) return fail(`flows/${key} already exists`);
    const prompt = importPrompt({
      sources: playbooks,
      targets: keys.map((k) => `flows/${k}/${k}.flow.yaml`),
    });
    return { uris: [], notes: [], prompt, started: await startAiImport(prompt, request.via) };
  }

  const resolveModule = deps.resolveModule?.(folder);
  const outcome: PlaybookImportOutcome = { uris: [], notes: [] };
  const counts: ImportResult['counts'][] = [];
  for (const [i, playbook] of playbooks.entries()) {
    const key = keys[i] as string;
    if (await exists(flowDir(folder, key)))
      return { ...outcome, error: `flows/${key} already exists` };
    const read = await readPlaybook(io, playbook, { ...(resolveModule ? { resolveModule } : {}) });
    if (!read.playbook) {
      outcome.notes.push(...read.notes.map((n) => `${playbook}: ${n}`));
      if (playbooks.length === 1)
        return { ...outcome, error: read.notes.join(' ') || `${playbook} is not a playbook` };
      continue;
    }
    if (!read.playbook.plays.length) {
      const error = `${playbook} has no plays (a task file or vars file?): import the playbook that uses it.`;
      if (playbooks.length === 1) return fail(error);
      outcome.notes.push(error);
      continue;
    }
    const result = importPlaybook(
      read.playbook,
      { key, newId: deps.newId, generatedDir: `flows/${key}/generated` },
      read.notes,
    );
    const uri = vscode.Uri.joinPath(flowDir(folder, key), `${key}.flow.yaml`);
    await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(flowText(result.doc)));
    outcome.uris.push(uri);
    counts.push(result.counts);
    outcome.notes.push(
      ...(playbooks.length > 1 ? result.notes.map((n) => `${key}: ${n}`) : result.notes),
    );
  }
  if (!outcome.uris.length) return { ...outcome, error: 'Nothing was imported.' };
  return { ...outcome, counts: addCounts(counts) };
}

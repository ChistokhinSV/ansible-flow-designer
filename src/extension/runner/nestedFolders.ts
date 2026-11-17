// AFD-323: a workspace folder that is not a git repository but holds repositories of flows (two
// clones of server projects in a downloads folder): the Flows pane says so, and offers them as
// workspace folders, where each has its server, pull, push and git trust. Asked once per set.
import * as vscode from 'vscode';
import { type NestedRepo, nestedRepos } from '../../node/runner/nestedRepos';

export const OPEN_NESTED = 'afd.flows.openNested';
const ASKED = 'afd.nestedAsked';

/** The nested repositories of the workspace's folders, by folder. */
export function findNested(): { folder: vscode.WorkspaceFolder; repos: NestedRepo[] }[] {
  const out: { folder: vscode.WorkspaceFolder; repos: NestedRepo[] }[] = [];
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    if (folder.uri.scheme !== 'file') continue;
    const repos = nestedRepos(folder.uri.fsPath).filter(
      // A repository that is a workspace folder already is not offered again.
      (r) =>
        !(vscode.workspace.workspaceFolders ?? []).some(
          (f) => f.uri.fsPath.toLowerCase() === r.path.toLowerCase(),
        ),
    );
    if (repos.length) out.push({ folder, repos });
  }
  return out;
}

/** The Flows pane's line for them (undefined: none). */
export function nestedNote(found = findNested()): string | undefined {
  const repos = found.flatMap((f) => f.repos);
  if (!repos.length) return undefined;
  const names = repos.map((r) => r.name).join(', ');
  return `${found.map((f) => f.folder.name).join(', ')} is not a git repository; it holds ${repos.length === 1 ? 'a repository' : `${repos.length} repositories`} of flows: ${names}. Pull, push and the server work per repository: the folder button on the pane opens them as workspace folders.`;
}

/**
 * Puts the nested repositories in the workspace in place of the folder that holds them (VS Code
 * makes an untitled multi-root workspace of it; Save Workspace As keeps it). Asked first, unless
 * `confirmed` (the test API).
 */
export async function openNested(confirmed = false): Promise<boolean> {
  const found = findNested();
  if (!found.length) {
    void vscode.window.showInformationMessage(
      'No repository of flows inside the workspace folders that is not a workspace folder already.',
    );
    return false;
  }
  if (!confirmed) {
    const yes = 'Open as Workspace Folders';
    const list = found
      .flatMap((f) =>
        f.repos.map(
          (r) => `${r.name}${r.server ? ` (${r.project ?? new URL(r.server).host})` : ''}`,
        ),
      )
      .join(', ');
    const pick = await vscode.window.showInformationMessage(
      `Open ${list} as the workspace's folders?`,
      {
        modal: true,
        detail: `They take the place of ${found.map((f) => f.folder.name).join(', ')} in this window: each gets its own server connection, pull and push in the Flows pane, and Source Control lists them as now. VS Code makes an untitled workspace of them; File › Save Workspace As… keeps it.`,
      },
      yes,
    );
    if (pick !== yes) return false;
  }
  // From the last folder, so the indexes of the ones before stay right.
  for (const { folder, repos } of [...found].sort((a, b) => b.folder.index - a.folder.index))
    vscode.workspace.updateWorkspaceFolders(
      folder.index,
      1,
      ...repos.map((r) => ({ uri: vscode.Uri.file(r.path), name: r.name })),
    );
  return true;
}

/** Once per window and set of repositories: a notice with the offer. */
export function offerNestedOnce(context: vscode.ExtensionContext): void {
  const found = findNested();
  if (!found.length) return;
  const key = found
    .flatMap((f) => f.repos.map((r) => r.path))
    .sort()
    .join('|');
  if (context.workspaceState.get<string>(ASKED) === key) return;
  void context.workspaceState.update(ASKED, key);
  const open = 'Open as Workspace Folders…';
  void vscode.window
    .showInformationMessage(
      nestedNote(found)?.replace(
        / Pull, push.*$/,
        ' Open them as workspace folders, so each has its server, pull and push?',
      ) ?? '',
      open,
    )
    .then((pick) => (pick === open ? openNested() : undefined));
}

export function registerNestedFolders(
  context: vscode.ExtensionContext,
  onChange: () => void,
): vscode.Disposable[] {
  setTimeout(() => offerNestedOnce(context), 1500);
  return [
    vscode.commands.registerCommand(OPEN_NESTED, () => openNested()),
    vscode.workspace.onDidChangeWorkspaceFolders(() => onChange()),
  ];
}

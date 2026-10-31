// User help (AFD-22): the guides shipped in docs/guide (shown in VS Code's Markdown preview), the
// Welcome-page walkthroughs, and the sample flows the tutorials start from.
import * as vscode from 'vscode';
import { parseFlow } from '../core/flow/document';

/** The first walkthrough ("Design your first Ansible flow"). */
const FIRST_WALKTHROUGH = 'afd.firstFlow';

/** A guide page under docs/guide: a relative `.md` path, never outside the folder. */
export function guidePage(page: unknown): string {
  const p = typeof page === 'string' ? page.trim().replaceAll('\\', '/') : '';
  if (!p) return 'README.md';
  if (!p.endsWith('.md') || p.startsWith('/') || p.split('/').includes('..')) return 'README.md';
  return p;
}

export function registerHelp(
  context: vscode.ExtensionContext,
  openFlow: (uri: vscode.Uri) => Thenable<unknown>,
): vscode.Disposable[] {
  const root = context.extensionUri;
  return [
    vscode.commands.registerCommand('afd.openGuide', async (page?: string) => {
      const uri = vscode.Uri.joinPath(root, 'docs', 'guide', guidePage(page));
      await vscode.commands.executeCommand('markdown.showPreview', uri);
    }),
    vscode.commands.registerCommand('afd.openWalkthrough', async () => {
      await vscode.commands.executeCommand(
        'workbench.action.openWalkthrough',
        `${context.extension.id}#${FIRST_WALKTHROUGH}`,
        false,
      );
    }),
    // A sample key (tests, links) skips the pick.
    vscode.commands.registerCommand('afd.openSample', (key?: string) =>
      openSample(root, openFlow, key),
    ),
  ];
}

interface Sample {
  file: vscode.Uri;
  key: string;
  name: string;
  goal: string;
}

async function samples(root: vscode.Uri): Promise<Sample[]> {
  const dir = vscode.Uri.joinPath(root, 'samples');
  const out: Sample[] = [];
  for (const [name, type] of await vscode.workspace.fs.readDirectory(dir)) {
    if (type !== vscode.FileType.File || !name.endsWith('.flow.yaml')) continue;
    const file = vscode.Uri.joinPath(dir, name);
    const text = new TextDecoder().decode(await vscode.workspace.fs.readFile(file));
    const flow = parseFlow(text).doc?.flow;
    if (flow?.key) out.push({ file, key: flow.key, name: flow.name, goal: flow.goal ?? '' });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Copies a bundled sample to `flows/<key>/<key>.flow.yaml` in the workspace and opens it. A sample
 * that is there already is opened as it is: it may have been changed while following a tutorial.
 */
async function openSample(
  root: vscode.Uri,
  openFlow: (uri: vscode.Uri) => Thenable<unknown>,
  key?: string,
): Promise<void> {
  const folders = vscode.workspace.workspaceFolders ?? [];
  if (folders.length === 0) {
    const pick = await vscode.window.showInformationMessage(
      'Open a folder (your automation repository, or an empty folder to try things out) first: the sample is copied into it.',
      'Open Folder…',
    );
    if (pick) await vscode.commands.executeCommand('workbench.action.files.openFolder');
    return;
  }
  const all = await samples(root);
  const given = all.find((s) => s.key === key);
  const chosen = given
    ? { sample: given }
    : await vscode.window.showQuickPick(
        all.map((s) => ({
          label: s.name,
          description: `flows/${s.key}/`,
          detail: s.goal,
          sample: s,
        })),
        { title: 'Open sample flow', placeHolder: 'A sample to copy into this workspace' },
      );
  if (!chosen) return;
  const folder =
    folders.length > 1
      ? await vscode.window.showWorkspaceFolderPick({ placeHolder: 'Folder for the sample' })
      : folders[0];
  if (!folder) return;
  const { key: name, file } = chosen.sample;
  const target = vscode.Uri.joinPath(folder.uri, 'flows', name, `${name}.flow.yaml`);
  let exists = true;
  try {
    await vscode.workspace.fs.stat(target);
  } catch {
    exists = false;
  }
  if (!exists) await vscode.workspace.fs.copy(file, target);
  else
    void vscode.window.showInformationMessage(
      `${vscode.workspace.asRelativePath(target)} is already in the workspace: opened it as it is.`,
    );
  await openFlow(target);
}

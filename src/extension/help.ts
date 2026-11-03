// User help (AFD-22): the guides shipped in docs/guide (shown in VS Code's Markdown preview), the
// Welcome-page walkthroughs, and the samples the tutorials start from: flows, and playbooks to
// import (AFD-28).
import * as vscode from 'vscode';
import { parseFlow } from '../core/flow/document';
import { CMD } from './commands/ids';

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
    vscode.commands.registerCommand(CMD.openGuide, async (page?: string) => {
      const uri = vscode.Uri.joinPath(root, 'docs', 'guide', guidePage(page));
      await vscode.commands.executeCommand('markdown.showPreview', uri);
    }),
    vscode.commands.registerCommand(CMD.getStarted, async () => {
      await vscode.commands.executeCommand(
        'workbench.action.openWalkthrough',
        `${context.extension.id}#${FIRST_WALKTHROUGH}`,
        false,
      );
    }),
    // A sample key (tests, links) skips the pick; tests may name the folder sample playbooks go to.
    vscode.commands.registerCommand(CMD.openSample, (key?: string, into?: vscode.Uri) =>
      openSample(root, openFlow, key, into),
    ),
  ];
}

interface Sample {
  file: vscode.Uri;
  key: string;
  name: string;
  goal: string;
}

/** A folder of sample playbooks to import (AFD-28): `samples/playbooks/<name>/`, keyed `playbooks/<name>`. */
interface PlaybookSample {
  dir: vscode.Uri;
  key: string;
  name: string;
  goal: string;
  /** Its top-level files and folders, which must not exist where it is copied. */
  entries: string[];
}

async function playbookSamples(root: vscode.Uri): Promise<PlaybookSample[]> {
  const base = vscode.Uri.joinPath(root, 'samples', 'playbooks');
  const out: PlaybookSample[] = [];
  let list: [string, vscode.FileType][] = [];
  try {
    list = await vscode.workspace.fs.readDirectory(base);
  } catch {
    return out;
  }
  for (const [name, type] of list) {
    if (type !== vscode.FileType.Directory) continue;
    const dir = vscode.Uri.joinPath(base, name);
    let goal = '';
    try {
      // The first comment of site.yml says what the playbooks do.
      const site = new TextDecoder().decode(
        await vscode.workspace.fs.readFile(vscode.Uri.joinPath(dir, 'site.yml')),
      );
      goal = /^#\s*(.+)$/m.exec(site)?.[1]?.trim() ?? '';
    } catch {}
    const entries = (await vscode.workspace.fs.readDirectory(dir)).map(([n]) => n);
    out.push({
      dir,
      key: `playbooks/${name}`,
      name: `Playbooks to import: ${name}`,
      goal,
      entries,
    });
  }
  return out;
}

/**
 * Copies sample playbooks into a folder for Tutorial 5 and offers to import them. They bring their
 * own ansible.cfg, inventory and roles, so a folder that has any of those is refused rather than
 * overwritten.
 */
async function copyPlaybooks(sample: PlaybookSample, target: vscode.Uri): Promise<void> {
  const clash: string[] = [];
  for (const entry of sample.entries) {
    try {
      await vscode.workspace.fs.stat(vscode.Uri.joinPath(target, entry));
      clash.push(entry);
    } catch {}
  }
  if (clash.length) {
    const open = 'Open Folder…';
    void vscode.window
      .showWarningMessage(
        `The sample playbooks bring ${sample.entries.join(', ')}; this folder already has ${clash.join(', ')}. Open an empty folder and run Open Sample again.`,
        open,
      )
      .then((pick) =>
        pick === open
          ? vscode.commands.executeCommand('workbench.action.files.openFolder')
          : undefined,
      );
    return;
  }
  for (const entry of sample.entries)
    await vscode.workspace.fs.copy(
      vscode.Uri.joinPath(sample.dir, entry),
      vscode.Uri.joinPath(target, entry),
    );
  await vscode.window.showTextDocument(vscode.Uri.joinPath(target, 'site.yml'), { preview: false });
  const go = 'Import Ansible Playbooks…';
  void vscode.window
    .showInformationMessage(
      'Sample playbooks copied. Import them into flows: Import Ansible Playbooks…, or right-click the folder in the Explorer (Tutorial 5).',
      go,
    )
    .then((p) =>
      p === go ? vscode.commands.executeCommand(CMD.importPlaybooks, target) : undefined,
    );
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
  // AFD-74: Hello, Ansible first: the smallest flow, the one to start with.
  return out.sort(
    (a, b) => Number(b.key === 'hello') - Number(a.key === 'hello') || a.name.localeCompare(b.name),
  );
}

/** No folder is open: say why one is needed and offer to open one (AFD-71). */
export async function askForFolder(why: string): Promise<void> {
  const pick = await vscode.window.showInformationMessage(
    `Open a folder first: your automation repository, or an empty folder to try things out. ${why}`,
    'Open Folder…',
  );
  if (pick) await vscode.commands.executeCommand('workbench.action.files.openFolder');
}

/**
 * Copies a bundled sample to `flows/<key>/<key>.flow.yaml` in the workspace and opens it. A sample
 * that is there already is opened as it is: it may have been changed while following a tutorial.
 */
async function openSample(
  root: vscode.Uri,
  openFlow: (uri: vscode.Uri) => Thenable<unknown>,
  key?: string,
  into?: vscode.Uri,
): Promise<void> {
  const folders = vscode.workspace.workspaceFolders ?? [];
  if (folders.length === 0) return askForFolder('The sample is copied into it.');
  const all = await samples(root);
  const books = await playbookSamples(root);
  const given = all.find((s) => s.key === key);
  const givenBooks = books.find((s) => s.key === key);
  type Pick = vscode.QuickPickItem & { sample?: Sample; books?: PlaybookSample };
  const chosen: Pick | undefined = given
    ? { label: given.name, sample: given }
    : givenBooks
      ? { label: givenBooks.name, books: givenBooks }
      : await vscode.window.showQuickPick<Pick>(
          [
            ...all.map((s) => ({
              label: s.name,
              description: `flows/${s.key}/`,
              detail: s.goal,
              sample: s,
            })),
            ...(books.length
              ? [{ label: 'Playbooks to import', kind: vscode.QuickPickItemKind.Separator }]
              : []),
            ...books.map((b) => ({
              label: b.name,
              description: 'site.yml, roles/, … into this folder',
              detail: b.goal,
              books: b,
            })),
          ],
          { title: 'Open sample flow', placeHolder: 'A sample to copy into this workspace' },
        );
  if (!chosen?.sample && !chosen?.books) return;
  if (chosen.books && into) return copyPlaybooks(chosen.books, into);
  const folder =
    folders.length > 1
      ? await vscode.window.showWorkspaceFolderPick({ placeHolder: 'Folder for the sample' })
      : folders[0];
  if (!folder) return;
  if (chosen.books) return copyPlaybooks(chosen.books, folder.uri);
  if (!chosen.sample) return;
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

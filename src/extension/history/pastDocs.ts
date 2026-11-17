// AFD-320: a file as a commit left it, as a read-only document (`afd-git:`). A flow opened this way
// shows in the designer as a past version: read-only, in the Changes lens against the version
// before the commit. The URI keeps the file's path (so the designer opens `*.flow.yaml`) and says
// in its query which repository, commit and path it is.
import { posix } from 'node:path';
import * as vscode from 'vscode';
import type { PastVersion } from '../../core/protocol';
import { textAtCommit } from '../../node/history/gitLog';
import { VIEW_TYPE } from '../host';

export const PAST_SCHEME = 'afd-git';

export interface PastRef extends PastVersion {
  /** The repository's top folder. */
  root: string;
  /** The path before the commit, when the commit renamed the file. */
  from?: string;
  /** The commit has a parent (not the repository's first commit). */
  parent: boolean;
}

/** The read-only document of `path` (relative to `root`) at the commit. */
export function pastUri(ref: PastRef): vscode.Uri {
  const file = vscode.Uri.file(posix.join(ref.root.replace(/\\/g, '/'), ref.path));
  return file.with({
    scheme: PAST_SCHEME,
    query: JSON.stringify(ref),
  });
}

/** The commit and file of an `afd-git:` URI, or undefined for any other. */
export function pastOf(uri: vscode.Uri): PastRef | undefined {
  if (uri.scheme !== PAST_SCHEME) return undefined;
  try {
    const ref = JSON.parse(uri.query) as PastRef;
    return typeof ref.hash === 'string' &&
      typeof ref.path === 'string' &&
      typeof ref.root === 'string'
      ? ref
      : undefined;
  } catch {
    return undefined;
  }
}

/** The file's text before the commit (at its parent, under its old name after a rename). */
export function textBefore(ref: PastRef): Promise<string | undefined> {
  if (!ref.parent) return Promise.resolve(undefined);
  return textAtCommit(ref.root, `${ref.hash}^`, ref.from ?? ref.path);
}

/** Opens the file at the commit: a flow in the designer, any other file as text. */
export async function openPast(ref: PastRef): Promise<void> {
  const uri = pastUri(ref);
  if (ref.path.endsWith('.flow.yaml'))
    await vscode.commands.executeCommand('vscode.openWith', uri, VIEW_TYPE, { preview: true });
  else await vscode.window.showTextDocument(uri, { preview: true });
}

/**
 * The change a commit made to a file that is not a flow: VS Code's diff of before and after. A
 * deleted file shows its last text; an added one its first.
 */
export async function openPastDiff(ref: PastRef, status: string): Promise<void> {
  const after = pastUri(ref);
  const title = `${posix.basename(ref.path)} (${ref.hash.slice(0, 7)})`;
  if (status === 'A' || !ref.parent) return void vscode.window.showTextDocument(after);
  if (status === 'D') {
    const last = pastUri({ ...ref, hash: `${ref.hash}^`, parent: true });
    return void vscode.window.showTextDocument(last);
  }
  const before = pastUri({ ...ref, hash: `${ref.hash}^`, path: ref.from ?? ref.path });
  await vscode.commands.executeCommand('vscode.diff', before, after, title);
}

/** Serves `afd-git:` documents from git. */
export function registerPastDocuments(): vscode.Disposable {
  const provider: vscode.TextDocumentContentProvider = {
    async provideTextDocumentContent(uri) {
      const ref = pastOf(uri);
      if (!ref) return '';
      return (await textAtCommit(ref.root, ref.hash, ref.path)) ?? '';
    },
  };
  return vscode.workspace.registerTextDocumentContentProvider(PAST_SCHEME, provider);
}

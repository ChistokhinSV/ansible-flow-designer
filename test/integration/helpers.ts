import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import * as vscode from 'vscode';
import type { AfdTestApi } from '../../src/extension/extension';

export const VIEW_TYPE = 'afd.flowEditor';
let api: AfdTestApi | undefined;

/**
 * Where the run tests run: the Docker image AFD_TEST_IMAGE, or the WSL distribution AFD_TEST_WSL
 * (AFD-75; .vscode-test.mjs sets the environment). Neither set skips them.
 */
export const runEnvironment =
  process.env.AFD_TEST_IMAGE ??
  (process.env.AFD_TEST_WSL ? `WSL ${process.env.AFD_TEST_WSL}` : undefined);

export async function testApi(): Promise<AfdTestApi> {
  if (api) return api;
  const ext = vscode.extensions.getExtension<AfdTestApi>('chistokhinsv.ansible-flow-designer');
  if (!ext) throw new Error('extension not found');
  api = await ext.activate();
  if (!api) throw new Error('extension is not in test mode');
  return api;
}

export function flowUri(key: string): vscode.Uri {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri;
  if (!root) throw new Error('no workspace');
  return vscode.Uri.joinPath(root, 'flows', key, `${key}.flow.yaml`);
}

export function sha(uri: vscode.Uri): string {
  return createHash('sha256').update(readFileSync(uri.fsPath)).digest('hex');
}

export function documentOf(uri: vscode.Uri): vscode.TextDocument {
  const doc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
  if (!doc) throw new Error(`not open: ${uri.toString()}`);
  return doc;
}

let warnedUnfocused = false;

/** Opens the flow in the designer and waits until its webview has rendered the current version. */
export async function openDesigner(uri: vscode.Uri): Promise<vscode.TextDocument> {
  const a = await testApi();
  await vscode.commands.executeCommand('vscode.openWith', uri, VIEW_TYPE);
  const doc = documentOf(uri);
  await withTimeout(a.rendered(uri, doc.version), 30_000, 'first render');
  // A view another test left focused (the chat, in VS Code 1.140) would take a test's Undo:
  // the designer's own panel takes the focus, as a click on it would.
  a.focusDesigner(uri);
  // Undo reaches a webview only while the window has the OS focus: another application in front
  // (someone using the PC during a run) fails the undo tests whatever the code does.
  if (!vscode.window.state.focused && !warnedUnfocused) {
    warnedUnfocused = true;
    console.log('[afd] the test window is not focused: undo checks fail until it is');
  }
  return doc;
}

/** Reverts dirty flow documents first, so closing never shows a save prompt. */
export async function closeAll(): Promise<void> {
  for (const doc of vscode.workspace.textDocuments) {
    if (!doc.isDirty) continue;
    await vscode.window.showTextDocument(doc);
    await vscode.commands.executeCommand('workbench.action.files.revert');
  }
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
}

export function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`timed out: ${what}`)), ms)),
  ]);
}

/** Lines that differ between two texts (same line count assumed for in-place edits). */
export function changedLines(before: string, after: string): string[] {
  const a = before.split('\n');
  const b = after.split('\n');
  const out: string[] = [];
  for (let i = 0; i < Math.max(a.length, b.length); i++) if (a[i] !== b[i]) out.push(b[i] ?? '');
  return out;
}

export function ids(text: string): string[] {
  return [...text.matchAll(/\b0[0-7][0-9A-HJKMNP-TV-Z]{24}\b/g)].map((m) => m[0]).sort();
}

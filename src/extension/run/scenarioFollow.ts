// Scenarios follow the flow in VS Code (AFD-115): an edit that renames or moves steps also
// rewrites the flow's scenarios file, in the same WorkspaceEdit. The file is read from its open
// document when it has one (unsaved edits included). Changed with the flow, it is saved with it.
import * as vscode from 'vscode';
import { isFileKey } from '../../core/flow/ids';
import type { FlowDocument } from '../../core/flow/types';
import { followPaths, pathChanges } from '../../core/scenario/follow';
import { scenariosFileName } from '../../core/scenario/scenarios';

/** Scenarios files changed with their flow and not saved yet: flow URI → scenarios URI. */
const withFlow = new Map<string, vscode.Uri>();

export interface ScenarioFollow {
  uri: vscode.Uri;
  /** Adds the scenarios file's edits to the flow's WorkspaceEdit. */
  apply(edit: vscode.WorkspaceEdit): void;
  /** What was rewritten (`gate → final-gate`). */
  notes: string[];
}

export function scenariosUri(flow: vscode.Uri, doc: FlowDocument): vscode.Uri {
  return vscode.Uri.joinPath(flow, '..', scenariosFileName(doc.flow.key));
}

async function openIfThere(uri: vscode.Uri): Promise<vscode.TextDocument | undefined> {
  const open = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
  if (open) return open;
  try {
    await vscode.workspace.fs.stat(uri);
  } catch {
    return undefined;
  }
  return vscode.workspace.openTextDocument(uri);
}

/**
 * The scenarios edit for a flow edit from `before` to `after`, or undefined when no key path moved
 * or nothing in the scenarios file names one.
 */
export async function followScenarios(
  flow: vscode.Uri,
  before: FlowDocument | null | undefined,
  after: FlowDocument | null | undefined,
): Promise<ScenarioFollow | undefined> {
  if (!before || !isFileKey(before.flow?.key) || !after) return undefined;
  const changes = pathChanges(before, after);
  if (changes.moved.size === 0) return undefined;
  const uri = scenariosUri(flow, before);
  const doc = await openIfThere(uri);
  if (!doc) return undefined;
  const result = followPaths(doc.getText(), changes);
  if (!result) return undefined;
  return {
    uri,
    notes: result.notes,
    apply(edit) {
      for (const e of result.edits)
        edit.replace(
          uri,
          new vscode.Range(doc.positionAt(e.start), doc.positionAt(e.end)),
          e.newText,
        );
      if (!doc.isDirty) withFlow.set(flow.toString(), uri);
    },
  };
}

/** After the flow is saved: its scenarios file too, when only the flow's edits changed it. */
export async function saveFollowed(flow: vscode.Uri): Promise<void> {
  const uri = withFlow.get(flow.toString());
  if (!uri) return;
  withFlow.delete(flow.toString());
  const doc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
  if (doc?.isDirty) await doc.save();
}

/** The status bar says what followed, for a few seconds. */
export function announceFollow(f: ScenarioFollow): void {
  const shown = f.notes.slice(0, 2).join(', ');
  const more = f.notes.length > 2 ? ` and ${f.notes.length - 2} more` : '';
  vscode.window.setStatusBarMessage(`Scenarios updated: ${shown}${more}`, 5000);
}

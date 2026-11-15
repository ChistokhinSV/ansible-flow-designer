// Roles into subflows in VS Code (AFD-293): Expand into Subflow reads the role a step runs from the
// workspace and puts the subflow in the step's place; Update Expanded Role reads it again after the
// role changed (the quick fix on its problem); Collapse to Role Step is a plain command of the flow.
import * as vscode from 'vscode';
import { createIdFactory } from '../core/flow/ids';
import { modelOf } from '../core/flow/model';
import { refDesign } from '../core/flow/refs';
import type { Ulid } from '../core/flow/types';
import { expandRoleSource } from '../core/import/expandRole';
import { CMD } from './commands/ids';
import type { Host } from './host';
import { workspaceSource } from './import/common';

/** The quick fix on a changed role: Update Expanded Role. */
export class ExpandedRoleActions implements vscode.CodeActionProvider {
  static readonly kinds = [vscode.CodeActionKind.QuickFix];

  provideCodeActions(
    document: vscode.TextDocument,
    _range: vscode.Range,
    context: vscode.CodeActionContext,
  ): vscode.CodeAction[] {
    return context.diagnostics
      .filter((d) => d.code === 'role-source' && d.severity !== vscode.DiagnosticSeverity.Warning)
      .map((d) => {
        const a = new vscode.CodeAction('Update Expanded Role', vscode.CodeActionKind.QuickFix);
        a.diagnostics = [d];
        a.command = {
          command: CMD.expandRole,
          title: 'Update Expanded Role',
          arguments: [document.uri, { code: d.code, message: d.message }],
        };
        return a;
      });
  }
}

type Target = Ulid | { code: string | number | { value: string | number }; message: string };

/**
 * Expand into Subflow on a role step, or Update Expanded Role on a subflow expanded from one: the
 * node by ID, or by the problem a quick fix came from.
 */
export async function expandRole(host: Host, uri: vscode.Uri | undefined, target: Target) {
  const doc = await host.resolveTargetFlow(uri);
  if (!doc) return undefined;
  const folder = vscode.workspace.getWorkspaceFolder(doc.uri);
  if (!folder) {
    void vscode.window.showErrorMessage(
      'Expand into Subflow reads the role from a workspace folder',
    );
    return undefined;
  }
  const session = host.sessionFor(doc);
  const snapshot = await session.snapshot();
  const id =
    typeof target === 'string'
      ? target
      : snapshot.findings.find(
          (f) =>
            f.code === (typeof target.code === 'object' ? target.code.value : target.code) &&
            f.message === target.message,
        )?.node;
  const node = id && snapshot.doc ? modelOf(snapshot.doc).nodes.get(id)?.node : undefined;
  if (!id || !node) {
    void vscode.window.showErrorMessage('That step is no longer in the flow');
    return undefined;
  }
  const was = node.expanded_from;
  if (was && refDesign(node) !== was.design) {
    const go = 'Update';
    const pick = await vscode.window.showWarningMessage(
      `"${node.title}" was changed since it was expanded from role ${was.role}. Updating replaces its steps with the role as it is now, and those changes are lost.`,
      { modal: true },
      go,
    );
    if (pick !== go) return undefined;
  }
  const step = was ? { key: node.key, impl: was.step.impl } : { key: node.key, impl: node.impl };
  const read = await expandRoleSource(workspaceSource(folder), step, createIdFactory());
  if (!read.source || !read.expanded) {
    void vscode.window.showErrorMessage(read.error ?? 'The role could not be read');
    return undefined;
  }
  const outcome = await session.runCommand({
    kind: 'expandRole',
    id,
    source: read.source,
    expanded: read.expanded,
  });
  if (!outcome.ok) void vscode.window.showErrorMessage(outcome.error ?? 'Not expanded');
  else if (read.notes.length) void vscode.window.showInformationMessage(read.notes.join(' '));
  return outcome;
}

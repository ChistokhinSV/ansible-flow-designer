// "Accept with Reason…" on a warning in the Problems panel (AFD-51): asks why, and the flow records
// an accepted decision (format 2), so the warning stops showing for that node. Open fail ports keep
// their own (the port's Accept with Reason…), since accepting one is a port decision.
import * as vscode from 'vscode';
import { CMD } from '../commands/ids';

export class AcceptProblemActions implements vscode.CodeActionProvider {
  static readonly kinds = [vscode.CodeActionKind.QuickFix];

  provideCodeActions(
    document: vscode.TextDocument,
    _range: vscode.Range,
    context: vscode.CodeActionContext,
  ): vscode.CodeAction[] {
    return context.diagnostics
      .filter(
        (d) =>
          d.source === 'Ansible Flow' &&
          d.severity === vscode.DiagnosticSeverity.Warning &&
          typeof d.code === 'string' &&
          d.code !== 'open-fail-port',
      )
      .map((d) => {
        const a = new vscode.CodeAction('Accept with Reason…', vscode.CodeActionKind.QuickFix);
        a.diagnostics = [d];
        a.command = {
          command: CMD.acceptProblem,
          title: 'Accept with Reason…',
          arguments: [document.uri, d.code, d.message],
        };
        return a;
      });
  }
}

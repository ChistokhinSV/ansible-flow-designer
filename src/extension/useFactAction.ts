// AFD-287: "Use … as an Input" on the unknown-variable warning when an earlier step sets the name
// with set_fact: the fact becomes that step's output and this step's input, in one edit.
import * as vscode from 'vscode';
import { CMD } from './commands/ids';

const SETS = /"(.+)" sets it \(set_fact\)/;

export class UseFactActions implements vscode.CodeActionProvider {
  static readonly kinds = [vscode.CodeActionKind.QuickFix];

  provideCodeActions(
    document: vscode.TextDocument,
    _range: vscode.Range,
    context: vscode.CodeActionContext,
  ): vscode.CodeAction[] {
    return context.diagnostics
      .filter(
        (d) =>
          d.source === 'Ansible Flow' && d.code === 'binding-unknown-var' && SETS.test(d.message),
      )
      .map((d) => {
        const name = /reads "([^"]+)"/.exec(d.message)?.[1] ?? 'it';
        const title = `Use ${name} as an Input (set by ${SETS.exec(d.message)?.[1]})`;
        const a = new vscode.CodeAction(title, vscode.CodeActionKind.QuickFix);
        a.diagnostics = [d];
        a.isPreferred = true;
        a.command = { command: CMD.useFact, title, arguments: [document.uri, d.message] };
        return a;
      });
  }
}

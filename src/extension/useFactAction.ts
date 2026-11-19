// AFD-287, AFD-343: "Add … as an Input" on the unknown-variable warnings in the text editor, the
// same fix as the step's own Details (AFD-336): an input from where the value is (a flow input,
// the subflow's input, an earlier step, a set_fact before it or inside an earlier subflow), or one
// set outside the flow, in one edit. The command works the fix out from the flow as it is then.
import * as vscode from 'vscode';
import { CMD } from './commands/ids';

const CODES = new Set(['binding-unknown-var', 'setting-unknown-var']);
const NAME = /reads (?:flow input )?"([^"]+)"/;

export class UseFactActions implements vscode.CodeActionProvider {
  static readonly kinds = [vscode.CodeActionKind.QuickFix];

  provideCodeActions(
    document: vscode.TextDocument,
    _range: vscode.Range,
    context: vscode.CodeActionContext,
  ): vscode.CodeAction[] {
    return context.diagnostics
      .filter(
        (d) => d.source === 'Ansible Flow' && CODES.has(String(d.code)) && NAME.test(d.message),
      )
      .map((d) => {
        const name = NAME.exec(d.message)?.[1] ?? 'it';
        const title = `Add ${name} as an Input`;
        const a = new vscode.CodeAction(title, vscode.CodeActionKind.QuickFix);
        a.diagnostics = [d];
        a.isPreferred = true;
        a.command = {
          command: CMD.useFact,
          title,
          arguments: [document.uri, d.message, String(d.code)],
        };
        return a;
      });
  }
}

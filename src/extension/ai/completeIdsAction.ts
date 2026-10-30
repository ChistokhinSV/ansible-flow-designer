// "Complete IDs" as a quick fix on the text of a flow written by hand (AFD-19): the light bulb on a
// `missing-id` problem, and the source action for the whole file. Both run afd.completeIds.
import * as vscode from 'vscode';

export const COMPLETE_IDS = 'afd.completeIds';
const SOURCE = vscode.CodeActionKind.Source.append('afd.completeIds');

export class CompleteIdsActions implements vscode.CodeActionProvider {
  static readonly kinds = [vscode.CodeActionKind.QuickFix, SOURCE];

  provideCodeActions(
    document: vscode.TextDocument,
    _range: vscode.Range,
    context: vscode.CodeActionContext,
  ): vscode.CodeAction[] {
    const gaps = vscode.languages
      .getDiagnostics(document.uri)
      .filter((d) => d.source === 'Ansible Flow' && d.code === 'missing-id');
    if (gaps.length === 0) return [];
    const here = context.diagnostics.filter((d) => d.code === 'missing-id');
    const wanted = context.only;
    const action = (kind: vscode.CodeActionKind, diagnostics: vscode.Diagnostic[]) => {
      const a = new vscode.CodeAction(`Complete IDs (${gaps.length} written by hand)`, kind);
      a.command = { command: COMPLETE_IDS, title: 'Complete IDs', arguments: [document.uri] };
      a.diagnostics = diagnostics;
      a.isPreferred = true;
      return a;
    };
    const out: vscode.CodeAction[] = [];
    if (here.length > 0 && (!wanted || wanted.contains(vscode.CodeActionKind.QuickFix)))
      out.push(action(vscode.CodeActionKind.QuickFix, here));
    if (wanted?.contains(SOURCE) || wanted?.contains(vscode.CodeActionKind.Source))
      out.push(action(SOURCE, gaps));
    return out;
  }
}

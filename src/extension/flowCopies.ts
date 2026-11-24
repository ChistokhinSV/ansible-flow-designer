// AFD-378: flows that share a flow ID, as copied in the Explorer, get a Problems warning on the ID,
// naming the other file, with a quick fix that gives the flow new IDs. The designer keeps pause
// points, remembered inputs and run history by the flow's ID and Code mode matches playbooks by
// node ID, so a copy that keeps them mixes with the original (a pause point set on the copy showed
// on the original).
import * as vscode from 'vscode';
import { keyFromFile, withNewIds } from '../core/flow/newIds';
import { CMD } from './commands/ids';
import type { Host } from './host';

export const FLOW_COPY = 'flow-copy';

async function textOf(uri: vscode.Uri): Promise<string> {
  const open = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
  if (open) return open.getText();
  try {
    return new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
  } catch {
    return '';
  }
}

/** Where the flow's ID is written (its first occurrence: `flow: id:` comes first). */
function rangeOf(text: string, id: string): vscode.Range {
  const at = Math.max(0, text.indexOf(id));
  const before = text.slice(0, at);
  const line = before.split('\n').length - 1;
  const character = at - (before.lastIndexOf('\n') + 1);
  return new vscode.Range(line, character, line, character + id.length);
}

export function registerFlowCopies(host: Host): vscode.Disposable[] {
  const problems = vscode.languages.createDiagnosticCollection('ansible-flow-copies');
  const publish = async () => {
    const next = new Map<string, vscode.Diagnostic[]>();
    for (const [id, flows] of host.index.copies())
      for (const f of flows) {
        const others = flows.filter((o) => o.uri.toString() !== f.uri.toString());
        const names = others.map((o) => vscode.workspace.asRelativePath(o.uri)).join(', ');
        const d = new vscode.Diagnostic(
          rangeOf(await textOf(f.uri), id),
          `This flow has the same flow ID as ${names}${others.some((o) => o.key === f.key) ? ', and the same key' : ''}: a copy? Pause points, remembered inputs, run history and Code mode follow the ID, so they mix. Give the copy new IDs (quick fix).`,
          vscode.DiagnosticSeverity.Warning,
        );
        d.source = 'Ansible Flow';
        d.code = FLOW_COPY;
        d.relatedInformation = others.map(
          (o) =>
            new vscode.DiagnosticRelatedInformation(
              new vscode.Location(o.uri, new vscode.Position(0, 0)),
              `The flow "${o.name}" with the same ID`,
            ),
        );
        next.set(f.uri.toString(), [d]);
      }
    problems.forEach((uri) => {
      if (!next.has(uri.toString())) problems.delete(uri);
    });
    for (const [uri, list] of next) problems.set(vscode.Uri.parse(uri), list);
  };
  return [
    problems,
    host.index.onDidChange(() => void publish()),
    vscode.languages.registerCodeActionsProvider(
      { pattern: '**/*.flow.yaml' },
      {
        provideCodeActions: (document, _range, context) =>
          context.diagnostics
            .filter((d) => d.code === FLOW_COPY)
            .map((d) => {
              const a = new vscode.CodeAction(
                'Give This Flow New IDs',
                vscode.CodeActionKind.QuickFix,
              );
              a.diagnostics = [d];
              a.command = {
                command: CMD.newFlowIds,
                title: 'Give This Flow New IDs',
                arguments: [document.uri],
              };
              return a;
            }),
      },
      { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] },
    ),
    vscode.commands.registerCommand(CMD.newFlowIds, async (uri?: vscode.Uri) => {
      const doc = await host.resolveTargetFlow(uri);
      if (!doc) return { ok: false, error: 'No flow' };
      const text = doc.getText();
      // A copy with the original's key also gets a key of its own, from its file name.
      const mine = [...host.index.copies().values()]
        .flat()
        .find((f) => f.uri.toString() === doc.uri.toString());
      const sameKey = [...host.index.copies().values()].some(
        (list) =>
          list.some((f) => f.uri.toString() === doc.uri.toString()) &&
          list.some((f) => f.uri.toString() !== doc.uri.toString() && f.key === mine?.key),
      );
      const name = doc.uri.path.split('/').pop() ?? '';
      const next = withNewIds(text, host.deps.newId, sameKey ? keyFromFile(name) : undefined);
      if (next === undefined) {
        void vscode.window.showErrorMessage('The flow does not parse: fix it first');
        return { ok: false, error: 'The flow does not parse' };
      }
      const edit = new vscode.WorkspaceEdit();
      edit.replace(doc.uri, new vscode.Range(0, 0, doc.lineCount, 0), next);
      const ok = await vscode.workspace.applyEdit(edit);
      if (ok) {
        await doc.save();
        vscode.window.setStatusBarMessage('$(check) The flow has new IDs', 4000);
      }
      return { ok };
    }),
  ];
}

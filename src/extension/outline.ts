// AFD-240: a flow open as text has an Outline and breadcrumbs: its nodes, a subflow holding the
// nodes inside it. AFD-236: a place chosen in that text by a command (a symbol of the Outline, a
// problem of the Problems panel, Go to Symbol) shows its node on the canvas when the designer is
// open; typing and clicking in the text do not move the canvas.
import * as vscode from 'vscode';
import { parseFlow } from '../core/flow/document';
import { modelOf } from '../core/flow/model';
import { flowOutline, type OutlineItem } from '../core/view/outline';
import type { Host } from './host';

const FLOWS: vscode.DocumentSelector = { pattern: '**/*.flow.yaml' };

function symbol(document: vscode.TextDocument, item: OutlineItem): vscode.DocumentSymbol {
  const start = document.positionAt(item.range[0]);
  const range = new vscode.Range(start, document.positionAt(item.range[1]));
  const first = document.lineAt(start.line).range;
  const out = new vscode.DocumentSymbol(
    // VS Code refuses a symbol without a name.
    item.name || '(untitled)',
    item.detail,
    item.subflow ? vscode.SymbolKind.Module : vscode.SymbolKind.Function,
    range,
    range.contains(first) ? first : range,
  );
  out.children = item.children.map((c) => symbol(document, c));
  return out;
}

export function registerOutline(host: Host): vscode.Disposable[] {
  return [
    vscode.languages.registerDocumentSymbolProvider(FLOWS, {
      provideDocumentSymbols(document) {
        try {
          const parsed = parseFlow(document.getText());
          if (!parsed.doc) return [];
          return flowOutline(parsed.file, modelOf(parsed.doc)).map((i) => symbol(document, i));
        } catch {
          // A flow that does not read as one has no outline; its problems say why.
          return [];
        }
      },
    }),
    vscode.window.onDidChangeTextEditorSelection((e) => {
      if (e.kind !== vscode.TextEditorSelectionChangeKind.Command) return;
      const session = host.sessions.get(e.textEditor.document.uri.toString());
      const at = e.selections[0]?.active;
      if (!session?.hasPanels || !at) return;
      session.revealAt(e.textEditor.document.offsetAt(at));
    }),
  ];
}

// Shared subflows in VS Code (AFD-60): Insert Shared Subflow… picks a subflow of another flow in the
// workspace and copies it here pinned to that flow's version; Update and Unlink act on a copy, from
// its problems' quick fixes or by node.
import { readFileSync } from 'node:fs';
import { dirname, relative } from 'node:path';
import * as vscode from 'vscode';
import { parse } from 'yaml';
import { formatOf } from '../core/flow/format';
import { subflowsOf } from '../core/flow/refs';
import type { FlowDocument, Position, Ulid } from '../core/flow/types';
import { sharedSource } from '../node/sharedRefs';
import { CMD } from './commands/ids';
import type { Host } from './host';

/** Quick fixes on a shared subflow's problems: Update from its source, or Unlink. */
export class SharedSubflowActions implements vscode.CodeActionProvider {
  static readonly kinds = [vscode.CodeActionKind.QuickFix];

  provideCodeActions(
    document: vscode.TextDocument,
    _range: vscode.Range,
    context: vscode.CodeActionContext,
  ): vscode.CodeAction[] {
    return context.diagnostics
      .filter((d) => d.code === 'shared-source' || d.code === 'shared-edited')
      .flatMap((d) =>
        [
          ...(d.severity === vscode.DiagnosticSeverity.Error
            ? []
            : [['Update Shared Subflow', CMD.updateShared]]),
          ['Unlink Shared Subflow', CMD.unlinkShared],
        ].map(([title, command]) => {
          const a = new vscode.CodeAction(title as string, vscode.CodeActionKind.QuickFix);
          a.diagnostics = [d];
          a.command = {
            command: command as string,
            title: title as string,
            arguments: [document.uri, { code: d.code, message: d.message }],
          };
          return a;
        }),
      );
  }
}

type Target = Ulid | { code: string | number | { value: string | number }; message: string };

/** The copy a command acts on: its ID, or the node of the problem a quick fix came from. */
async function copyOf(host: Host, uri: vscode.Uri | undefined, target: Target) {
  const doc = await host.resolveTargetFlow(uri);
  if (!doc) return undefined;
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
  const node = id ? snapshot.doc?.nodes && findNode(snapshot.doc, id) : undefined;
  if (!id || !node?.ref) {
    void vscode.window.showErrorMessage('That shared subflow is no longer in the flow');
    return undefined;
  }
  return { doc, session, id, node };
}

function findNode(doc: FlowDocument, id: Ulid) {
  const walk = (
    nodes: FlowDocument['nodes'] | undefined,
  ): FlowDocument['nodes'][number] | undefined => {
    for (const n of nodes ?? []) {
      if (n?.id === id) return n;
      const inner = walk(n?.subflow?.nodes);
      if (inner) return inner;
    }
    return undefined;
  };
  return walk(doc.nodes);
}

export async function updateShared(host: Host, uri: vscode.Uri | undefined, target: Target) {
  const copy = await copyOf(host, uri, target);
  if (!copy?.node.ref) return undefined;
  const src = sharedSource(
    copy.doc.uri.fsPath,
    copy.node.ref.from,
    vscode.workspace.getWorkspaceFolder(copy.doc.uri)?.uri.fsPath,
  );
  if (!src.node || src.version === undefined) {
    void vscode.window.showErrorMessage(src.error ?? 'The source is gone');
    return undefined;
  }
  return copy.session.runCommand({
    kind: 'updateReference',
    id: copy.id,
    version: src.version,
    source: src.node,
  });
}

export async function unlinkShared(host: Host, uri: vscode.Uri | undefined, target: Target) {
  const copy = await copyOf(host, uri, target);
  if (!copy) return undefined;
  return copy.session.runCommand({ kind: 'unlinkReference', id: copy.id });
}

/**
 * Insert Shared Subflow…: every subflow of the other flows in the workspace, by file and key path;
 * the copy goes on `level` (the top level by default) at `position`.
 */
export async function insertShared(
  host: Host,
  uri?: vscode.Uri,
  where: { level?: string; position?: Position; pick?: string } = {},
) {
  const doc = await host.resolveTargetFlow(uri);
  if (!doc) return undefined;
  const flow = parse(doc.getText()) as FlowDocument;
  if (formatOf(flow) < 2) {
    const upgrade = 'Upgrade Flow Format';
    const pick = await vscode.window.showWarningMessage(
      'Shared subflows need flow format 2.',
      upgrade,
    );
    if (pick === upgrade) await vscode.commands.executeCommand(CMD.upgradeFormat, doc.uri);
    return undefined;
  }
  const files = await vscode.workspace.findFiles('**/*.flow.yaml', '**/node_modules/**', 500);
  const items: (vscode.QuickPickItem & { from: string; file: string; path: string })[] = [];
  for (const f of files) {
    if (f.fsPath === doc.uri.fsPath) continue;
    let other: FlowDocument;
    try {
      other = parse(readFileSync(f.fsPath, 'utf8')) as FlowDocument;
    } catch {
      continue;
    }
    if (!other?.flow) continue;
    const rel = relative(dirname(doc.uri.fsPath), f.fsPath).replaceAll('\\', '/');
    for (const s of subflowsOf(other))
      items.push({
        label: s.node.title,
        description: `${rel}#${s.path}`,
        detail: `${other.flow.name}, version ${other.flow.version}${s.node.intent ? ` · ${s.node.intent}` : ''}`,
        from: `${rel}#${s.path}`,
        file: f.fsPath,
        path: s.path,
      });
  }
  if (items.length === 0) {
    void vscode.window.showInformationMessage(
      'No other flow in the workspace has a subflow with steps to share.',
    );
    return undefined;
  }
  const chosen = where.pick
    ? items.find((i) => i.from === where.pick)
    : await vscode.window.showQuickPick(items, {
        title: 'Insert Shared Subflow',
        placeHolder: 'A subflow of another flow, copied here at its current version',
        matchOnDescription: true,
        matchOnDetail: true,
      });
  if (!chosen) return undefined;
  const src = sharedSource(
    doc.uri.fsPath,
    chosen.from,
    vscode.workspace.getWorkspaceFolder(doc.uri)?.uri.fsPath,
  );
  if (!src.node || src.version === undefined) {
    void vscode.window.showErrorMessage(src.error ?? 'The subflow is gone');
    return undefined;
  }
  const outcome = await host.sessionFor(doc).runCommand({
    kind: 'addReference',
    ...(where.level && where.level !== 'root' ? { parent: where.level } : {}),
    from: chosen.from,
    version: src.version,
    source: src.node,
    ...(where.position ? { position: where.position } : {}),
  });
  if (!outcome.ok) void vscode.window.showErrorMessage(outcome.error ?? 'Not inserted');
  return outcome;
}

/** A flow file saved or changed on disk: open flows with shared subflows check their sources again. */
export function watchSharedSources(host: Host): vscode.Disposable {
  const watcher = vscode.workspace.createFileSystemWatcher('**/*.flow.yaml');
  const recheck = (uri: vscode.Uri) => {
    for (const s of host.sessions.values())
      if (s.document.uri.toString() !== uri.toString() && s.sharesSubflows) void s.recheck();
  };
  return vscode.Disposable.from(
    watcher,
    watcher.onDidChange(recheck),
    watcher.onDidCreate(recheck),
    watcher.onDidDelete(recheck),
  );
}

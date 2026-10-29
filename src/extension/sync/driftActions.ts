// Drift actions that write code (M6, D-29 "design without code"): a role stub for an unbound
// node, and argument_specs for a bound role without them (decision M6-3). The design side of a
// stub (the binding) goes into the same WorkspaceEdit as the new files.
import * as vscode from 'vscode';
import { tasksFromOf } from '../../core/drift/drift';
import { addSpecEntry, argumentSpecsText, roleStub } from '../../core/drift/stub';
import type { CodeScan } from '../../core/drift/types';
import type { FlowCommand } from '../../core/flow/commands';
import { buildModel } from '../../core/flow/model';
import type { FlowDocument } from '../../core/flow/types';

const encoder = new TextEncoder();

export interface DriftHost {
  uri: vscode.Uri;
  doc: FlowDocument;
  /** Runs a flow command; `extra` adds file operations to the same WorkspaceEdit. */
  runCommand(
    command: FlowCommand,
    extra?: (edit: vscode.WorkspaceEdit) => void,
  ): Promise<{ ok: boolean; error?: string }>;
}

async function exists(uri: vscode.Uri): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(uri);
    return true;
  } catch {
    return false;
  }
}

function folderOf(uri: vscode.Uri): vscode.WorkspaceFolder {
  const folder = vscode.workspace.getWorkspaceFolder(uri);
  if (!folder) throw new Error('Open the flow inside a workspace folder');
  return folder;
}

/** Scaffolds roles/<role>/ from the node contract and binds the node to it, in one edit. */
export async function generateStub(host: DriftHost, nodeId: string, role: string) {
  const node = buildModel(host.doc).nodes.get(nodeId)?.node;
  if (!node) return { ok: false, error: `No node ${nodeId}` };
  const folder = folderOf(host.uri);
  const files = roleStub(node, host.doc.flow, role).map((f) => ({
    uri: vscode.Uri.joinPath(folder.uri, f.path),
    text: f.text,
    path: f.path,
  }));
  if (await exists(vscode.Uri.joinPath(folder.uri, 'roles', role)))
    return { ok: false, error: `roles/${role} already exists: bind the node to it instead` };
  // A missing role keeps its binding (the stub is created under the bound name).
  const impl =
    node.impl?.kind === 'role' && node.impl.ref === role
      ? node.impl
      : { kind: 'role' as const, ref: role };
  return host.runCommand({ kind: 'setBinding', id: node.id, impl }, (edit) => {
    for (const f of files) edit.createFile(f.uri, { contents: encoder.encode(f.text) });
  });
}

/** Writes meta/argument_specs.yml (or adds the entry point to it) from the node's inputs. */
export async function writeSpecs(host: DriftHost, nodeId: string, scan: CodeScan | undefined) {
  const node = buildModel(host.doc).nodes.get(nodeId)?.node;
  if (node?.impl?.kind !== 'role') return { ok: false, error: 'The node is not bound to a role' };
  const info = scan?.roleInfo.find((r) => r.name === node.impl?.ref);
  if (!info) return { ok: false, error: `Role ${node.impl.ref} was not found: re-sync first` };
  const folder = folderOf(host.uri);
  const entry = tasksFromOf(node) ?? 'main';
  const meta = vscode.Uri.joinPath(folder.uri, info.path, 'meta');
  const yaml = vscode.Uri.joinPath(meta, 'argument_specs.yaml');
  const target = (await exists(yaml)) ? yaml : vscode.Uri.joinPath(meta, 'argument_specs.yml');
  const edit = new vscode.WorkspaceEdit();
  let doc: vscode.TextDocument | undefined;
  if (!(await exists(target))) {
    edit.createFile(target, { contents: encoder.encode(argumentSpecsText(node, entry)) });
  } else {
    doc = await vscode.workspace.openTextDocument(target);
    const planned = addSpecEntry(doc.getText(), node, entry);
    if (!planned)
      return { ok: false, error: `${info.name} already has argument_specs for ${entry}` };
    for (const e of planned.edits)
      edit.replace(
        target,
        new vscode.Range(doc.positionAt(e.start), doc.positionAt(e.end)),
        e.newText,
      );
  }
  if (!(await vscode.workspace.applyEdit(edit)))
    return { ok: false, error: 'VS Code rejected the edit' };
  // The probe reads the file from disk.
  if (doc) await doc.save();
  return { ok: true };
}

/** Opens a repository file at a line (1-based). */
export async function openCode(flow: vscode.Uri, path: string, line?: number): Promise<void> {
  const folder = folderOf(flow);
  const uri = /^([a-zA-Z]:)?[\\/]/.test(path)
    ? vscode.Uri.file(path)
    : vscode.Uri.joinPath(folder.uri, path);
  const at = new vscode.Position(Math.max(0, (line ?? 1) - 1), 0);
  await vscode.window.showTextDocument(uri, {
    selection: new vscode.Range(at, at),
    preview: false,
  });
}

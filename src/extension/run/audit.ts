// Local audit log of run launches (decision 18): one JSON object per line in global storage. The
// log itself is node/run/audit.ts (AFD-271); this names it for VS Code.
import * as vscode from 'vscode';
import { appendAudit as append, auditFile } from '../../node/run/audit';

export function auditUri(storage: vscode.Uri): vscode.Uri {
  return vscode.Uri.file(auditFile(storage.fsPath));
}

export function appendAudit(storage: vscode.Uri, entry: Record<string, unknown>): Promise<void> {
  return append(storage.fsPath, entry);
}

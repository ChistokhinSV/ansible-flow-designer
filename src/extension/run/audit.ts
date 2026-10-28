// Local audit log of run launches (decision 18): one JSON object per line in global storage. No
// secrets: input values and passwords are never written here.
import { appendFile, mkdir } from 'node:fs/promises';
import * as vscode from 'vscode';

export function auditUri(storage: vscode.Uri): vscode.Uri {
  return vscode.Uri.joinPath(storage, 'audit.jsonl');
}

export async function appendAudit(
  storage: vscode.Uri,
  entry: Record<string, unknown>,
): Promise<void> {
  await mkdir(storage.fsPath, { recursive: true });
  const line = `${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`;
  await appendFile(auditUri(storage).fsPath, line, 'utf8');
}

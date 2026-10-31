// Local audit log of run launches (decision 18): one JSON object per line in global storage. No
// secrets: input values and passwords are never written here. The log rotates at 1 MB and keeps
// two older files (AFD-29).
import { appendFile, mkdir } from 'node:fs/promises';
import * as vscode from 'vscode';
import { rotateLog } from '../../node/run/storage';

/** Size at which audit.jsonl moves to audit.1.jsonl; audit.1 and audit.2 are kept. */
const AUDIT_ROTATE_BYTES = 1024 * 1024;
const AUDIT_OLD_FILES = 2;

export function auditUri(storage: vscode.Uri): vscode.Uri {
  return vscode.Uri.joinPath(storage, 'audit.jsonl');
}

export async function appendAudit(
  storage: vscode.Uri,
  entry: Record<string, unknown>,
): Promise<void> {
  await mkdir(storage.fsPath, { recursive: true });
  await rotateLog(auditUri(storage).fsPath, AUDIT_ROTATE_BYTES, AUDIT_OLD_FILES);
  const line = `${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`;
  await appendFile(auditUri(storage).fsPath, line, 'utf8');
}

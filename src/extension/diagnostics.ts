import * as vscode from 'vscode';
import { rangeOf } from '../core/flow/document';
import type { Finding } from '../core/flow/validate';
import type { YamlFile } from '../core/yaml/parse';

const SEVERITY: Record<Finding['severity'], vscode.DiagnosticSeverity> = {
  error: vscode.DiagnosticSeverity.Error,
  warning: vscode.DiagnosticSeverity.Warning,
  info: vscode.DiagnosticSeverity.Information,
};

export function toDiagnostics(
  document: vscode.TextDocument,
  file: YamlFile,
  findings: readonly Finding[],
): vscode.Diagnostic[] {
  return findings.map((f) => {
    const [start, end] = rangeOf(file, f.path);
    const d = new vscode.Diagnostic(
      new vscode.Range(document.positionAt(start), document.positionAt(end)),
      f.message,
      SEVERITY[f.severity],
    );
    d.source = 'Ansible Flow';
    d.code = f.code;
    return d;
  });
}

export function parseErrorDiagnostic(
  document: vscode.TextDocument,
  message: string,
  offset: number,
): vscode.Diagnostic {
  const pos = document.positionAt(offset);
  const d = new vscode.Diagnostic(new vscode.Range(pos, pos.translate(0, 1)), message);
  d.source = 'Ansible Flow';
  d.code = 'yaml';
  return d;
}

// `ansible-playbook --syntax-check` of the generated code inside the flow's environment (modules
// must exist there, 07 §5). Errors become diagnostics on the generated files.
import * as vscode from 'vscode';
import { parseFlow } from '../../core/flow/document';
import type { SchemaValidator } from '../../core/flow/schema';
import { generateFlow } from '../codegen';
import type { ProbeManager } from '../env/environment';

export interface SyntaxOutcome {
  ok: boolean;
  message: string;
  errors: { message: string; path?: string; line?: number; column?: number }[];
}

interface ProbeSyntax {
  ok: boolean;
  rc: number;
  errors: SyntaxOutcome['errors'];
  output: string;
}

export async function syntaxCheck(
  doc: vscode.TextDocument,
  schema: SchemaValidator,
  probes: ProbeManager,
  diagnostics: vscode.DiagnosticCollection,
): Promise<SyntaxOutcome> {
  const folder = vscode.workspace.getWorkspaceFolder(doc.uri);
  if (!folder) return { ok: false, message: 'Open the repository folder first', errors: [] };
  if (doc.isDirty) await doc.save();
  const generated = await generateFlow(doc, schema);
  if (!generated.ok || !generated.result || !generated.dir)
    return { ok: false, message: generated.error ?? 'Code generation failed', errors: [] };
  const probe = probes.forFolder(folder.uri);
  if ('error' in probe) return { ok: false, message: probe.error, errors: [] };

  // Ansible templates `hosts:` even in a syntax check, so host_list inputs need a placeholder.
  const flow = parseFlow(doc.getText()).doc;
  const placeholders: Record<string, unknown> = {};
  for (const [name, field] of Object.entries(flow?.flow.inputs ?? {}))
    if (field?.type === 'host_list') placeholders[name] = ['localhost'];
  const root = generated.result.files[0]?.name ?? '';
  const playbook = vscode.workspace
    .asRelativePath(vscode.Uri.joinPath(generated.dir, root), false)
    .replaceAll('\\', '/');
  const inventory =
    vscode.workspace.getConfiguration('afd', doc.uri).get<string>('run.inventory', '') || undefined;

  let result: ProbeSyntax;
  try {
    result = await probe.client.call<ProbeSyntax>(
      'syntax_check',
      { playbook, inventory, extra_vars: placeholders },
      180_000,
    );
  } catch (e) {
    return { ok: false, message: `${probe.label}: ${(e as Error).message}`, errors: [] };
  }

  for (const f of generated.result.files)
    diagnostics.delete(vscode.Uri.joinPath(generated.dir, f.name));
  const byFile = new Map<string, vscode.Diagnostic[]>();
  for (const err of result.errors) {
    if (!err.path) continue;
    const host = probe.client.toHost(err.path);
    const line = Math.max(0, (err.line ?? 1) - 1);
    const col = Math.max(0, (err.column ?? 1) - 1);
    const d = new vscode.Diagnostic(new vscode.Range(line, col, line, col + 1), err.message);
    d.source = 'ansible-playbook --syntax-check';
    byFile.set(host, [...(byFile.get(host) ?? []), d]);
  }
  for (const [path, list] of byFile) diagnostics.set(vscode.Uri.file(path), list);

  const files = generated.result.files.length;
  return result.ok
    ? {
        ok: true,
        message: `Generated code passes the syntax check (${probe.label}, ${files} file(s))`,
        errors: [],
      }
    : {
        ok: false,
        message: `Syntax check failed (${probe.label}): ${result.errors[0]?.message ?? 'see Problems'}`,
        errors: result.errors,
      };
}

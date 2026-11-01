// What every run and check does first (AFD-37: local runs, AWX launches and the syntax check
// shared copies of it): save the flow, find its repository folder, generate the code and read the
// flow; and the audit header naming who ran which flow version.
import * as vscode from 'vscode';
import { parseFlow } from '../../core/flow/document';
import type { SchemaValidator } from '../../core/flow/schema';
import type { FlowDocument } from '../../core/flow/types';
import { type CodegenOutcome, generateFlow } from '../codegen';
import { authorName } from '../gitHead';

/** A run id: the start time, sortable (run folders are pruned by it, AFD-29). */
export function stamp(d = new Date()): string {
  return d
    .toISOString()
    .replaceAll(/[-:]/g, '')
    .replace(/\.\d+Z$/, 'Z');
}

type Generated = CodegenOutcome & { result: NonNullable<CodegenOutcome['result']> };

export type Prepared =
  | { ok: true; folder: vscode.WorkspaceFolder; generated: Generated; doc: FlowDocument }
  | { ok: false; error: string };

/**
 * Saves the flow, generates its code and reads it. `refuseKept`: a generated file edited by hand
 * stops the run (local runs run exactly what the flow says).
 */
export async function prepareRun(
  document: vscode.TextDocument,
  schema: SchemaValidator,
  options: { refuseKept?: boolean } = {},
): Promise<Prepared> {
  if (document.isDirty) await document.save();
  const folder = vscode.workspace.getWorkspaceFolder(document.uri);
  if (!folder)
    return { ok: false, error: 'Open the repository folder that contains this flow first' };
  const generated = await generateFlow(document, schema);
  if (!generated.ok || !generated.result)
    return { ok: false, error: generated.error ?? 'Code generation failed' };
  if (options.refuseKept && generated.kept.length > 0)
    return { ok: false, error: 'Generated code was edited by hand: run "Generate Code" first' };
  const doc = parseFlow(document.getText()).doc;
  if (!doc) return { ok: false, error: 'The flow does not parse' };
  return { ok: true, folder, generated: generated as Generated, doc };
}

/** Who ran which flow version, for the audit log (never input values). */
export async function auditHeader(document: vscode.TextDocument, doc: FlowDocument) {
  return {
    user: await authorName(document.uri),
    flow: {
      id: doc.flow.id,
      key: doc.flow.key,
      version: doc.flow.version,
      file: vscode.workspace.asRelativePath(document.uri),
    },
  };
}

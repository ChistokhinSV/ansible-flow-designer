// Writes generated code next to a flow (ADR-0009): generated/<flow-key>.yml plus one file per
// subflow level, only when the content changed, never over hand edits unless forced.
import * as vscode from 'vscode';
import { GENERATED_MARK, generatedState } from '../core/engine/files';
import { optionA } from '../core/engine/optionA';
import type { GenerateResult } from '../core/engine/types';
import { parseFlow } from '../core/flow/document';
import type { SchemaValidator } from '../core/flow/schema';
import { validateFlow } from '../core/flow/validate';

export interface CodegenOutcome {
  ok: boolean;
  error?: string;
  written: vscode.Uri[];
  /** Files that exist but were edited by hand (or are not ours): left alone unless forced. */
  kept: vscode.Uri[];
  removed: vscode.Uri[];
  result?: GenerateResult;
  dir?: vscode.Uri;
}

const decoder = new TextDecoder();
const encoder = new TextEncoder();

async function readText(uri: vscode.Uri): Promise<string | undefined> {
  try {
    return decoder.decode(await vscode.workspace.fs.readFile(uri));
  } catch {
    return undefined;
  }
}

export function generatedDir(flow: vscode.Uri): vscode.Uri {
  return vscode.Uri.joinPath(flow, '..', 'generated');
}

export async function generateFlow(
  document: vscode.TextDocument,
  schema: SchemaValidator,
  options: { force?: boolean } = {},
): Promise<CodegenOutcome> {
  const empty = { written: [], kept: [], removed: [] };
  const text = document.getText();
  const parsed = parseFlow(text);
  if (!parsed.doc) return { ok: false, error: 'The flow does not parse', ...empty };
  const errors = validateFlow(parsed.doc, schema(parsed.doc)).findings.filter(
    (f) => f.severity === 'error',
  );
  if (errors.length > 0)
    return {
      ok: false,
      error: `The flow has ${errors.length} error(s); generated code was not updated`,
      ...empty,
    };
  const source = document.uri.path.split('/').pop() ?? 'flow.yaml';
  const result = optionA.generate(parsed.doc, {
    source,
    eol: text.includes('\r\n') ? '\r\n' : '\n',
  });
  if (!result.ok)
    return {
      ok: false,
      error: result.findings[0]?.message ?? 'Code generation failed',
      ...empty,
      result,
    };

  const dir = generatedDir(document.uri);
  const outcome: CodegenOutcome = { ok: true, written: [], kept: [], removed: [], result, dir };
  for (const file of result.files) {
    const uri = vscode.Uri.joinPath(dir, file.name);
    const existing = await readText(uri);
    if (existing === file.text) continue;
    if (existing !== undefined && !options.force) {
      const state = generatedState(existing);
      if (!state.ours || state.edited) {
        outcome.kept.push(uri);
        continue;
      }
    }
    await vscode.workspace.fs.writeFile(uri, encoder.encode(file.text));
    outcome.written.push(uri);
  }

  // Level files of this flow that are no longer generated (a subflow lost its inner graph).
  const key = parsed.doc.flow.key;
  const names = new Set(result.files.map((f) => f.name));
  let entries: [string, vscode.FileType][] = [];
  try {
    entries = await vscode.workspace.fs.readDirectory(dir);
  } catch {}
  for (const [name, type] of entries) {
    if (type !== vscode.FileType.File || names.has(name)) continue;
    if (!name.startsWith(`${key}.`) || !name.endsWith('.yml')) continue;
    const uri = vscode.Uri.joinPath(dir, name);
    const existing = await readText(uri);
    if (!existing?.startsWith(GENERATED_MARK) || generatedState(existing).edited) continue;
    await vscode.workspace.fs.delete(uri);
    outcome.removed.push(uri);
  }
  return outcome;
}

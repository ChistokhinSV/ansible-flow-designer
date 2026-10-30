// Writes generated code next to a flow (ADR-0009): generated/<flow-key>.yml plus one file per
// subflow level, only when the content changed, never over hand edits unless forced. What to write
// is decided by the core write plan, shared with the MCP server (AFD-19).
import * as vscode from 'vscode';
import type { GenerateResult } from '../core/engine/types';
import { planGenerated } from '../core/engine/writePlan';
import type { SchemaValidator } from '../core/flow/schema';

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

/** The repository root as seen from generated/ (`../../..` for flows/<key>/generated). */
export function rootFromGenerated(flow: vscode.Uri): string | undefined {
  const folder = vscode.workspace.getWorkspaceFolder(flow);
  if (!folder) return undefined;
  const base = folder.uri.path.replace(/\/+$/, '');
  const depth = generatedDir(flow).path.slice(base.length).split('/').filter(Boolean).length;
  return depth > 0 ? Array.from({ length: depth }, () => '..').join('/') : '.';
}

export async function generateFlow(
  document: vscode.TextDocument,
  schema: SchemaValidator,
  options: { force?: boolean } = {},
): Promise<CodegenOutcome> {
  const dir = generatedDir(document.uri);
  const plan = await planGenerated(
    document.getText(),
    schema,
    {
      read: (name) => readText(vscode.Uri.joinPath(dir, name)),
      list: async () => {
        try {
          return (await vscode.workspace.fs.readDirectory(dir))
            .filter(([, type]) => type === vscode.FileType.File)
            .map(([name]) => name);
        } catch {
          return [];
        }
      },
    },
    {
      source: document.uri.path.split('/').pop() ?? 'flow.yaml',
      root: rootFromGenerated(document.uri),
      force: options.force,
    },
  );
  const at = (name: string) => vscode.Uri.joinPath(dir, name);
  if (!plan.ok)
    return {
      ok: false,
      error: plan.error,
      written: [],
      kept: [],
      removed: [],
      ...(plan.result ? { result: plan.result } : {}),
    };
  const outcome: CodegenOutcome = {
    ok: true,
    written: [],
    kept: plan.kept.map(at),
    removed: [],
    result: plan.result,
    dir,
  };
  for (const file of plan.write) {
    await vscode.workspace.fs.writeFile(at(file.name), encoder.encode(file.text));
    outcome.written.push(at(file.name));
  }
  for (const name of plan.remove) {
    await vscode.workspace.fs.delete(at(name));
    outcome.removed.push(at(name));
  }
  return outcome;
}

// What a save writes into generated/ (ADR-0009), decided without touching disk so the extension and
// the MCP server (AFD-19) share it: changed files only, never over hand edits unless forced, and
// level files the flow no longer generates removed when they are ours and untouched.
import { parseFlow } from '../flow/document';
import type { SchemaIssue } from '../flow/schema';
import { validateFlow } from '../flow/validate';
import { GENERATED_MARK, generatedState } from './files';
import { optionA } from './optionA';
import type { GenerateResult } from './types';

export interface GeneratedDir {
  /** Text of generated/<name>, undefined when it does not exist. */
  read(name: string): Promise<string | undefined>;
  /** File names in generated/ (empty when the folder does not exist). */
  list(): Promise<string[]>;
}

export interface WritePlan {
  ok: boolean;
  error?: string;
  write: { name: string; text: string }[];
  /** Exist but were edited by hand (or are not ours): left alone unless forced. */
  kept: string[];
  remove: string[];
  result?: GenerateResult;
}

export async function planGenerated(
  text: string,
  schema: (doc: unknown) => SchemaIssue[],
  dir: GeneratedDir,
  options: { source: string; root?: string; force?: boolean },
): Promise<WritePlan> {
  const empty = { write: [], kept: [], remove: [] };
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
  const result = optionA.generate(parsed.doc, {
    source: options.source,
    eol: text.includes('\r\n') ? '\r\n' : '\n',
    root: options.root,
  });
  if (!result.ok)
    return {
      ok: false,
      error: result.findings[0]?.message ?? 'Code generation failed',
      ...empty,
      result,
    };

  const plan: WritePlan = { ok: true, write: [], kept: [], remove: [], result };
  for (const file of result.files) {
    const existing = await dir.read(file.name);
    if (existing === file.text) continue;
    if (existing !== undefined && !options.force) {
      const state = generatedState(existing);
      if (!state.ours || state.edited) {
        plan.kept.push(file.name);
        continue;
      }
    }
    plan.write.push(file);
  }

  // Level files of this flow that are no longer generated (a subflow lost its inner graph).
  const key = parsed.doc.flow.key;
  const names = new Set(result.files.map((f) => f.name));
  for (const name of await dir.list()) {
    if (names.has(name) || !name.startsWith(`${key}.`) || !name.endsWith('.yml')) continue;
    const existing = await dir.read(name);
    if (!existing?.startsWith(GENERATED_MARK) || generatedState(existing).edited) continue;
    plan.remove.push(name);
  }
  return plan;
}

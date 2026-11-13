// Flow inputs for runs (AFD-37: shared by local runs, AWX launches and the lenses): given values,
// else remembered ones per flow in this workspace, else prompted; secrets typed hidden and never
// remembered (AFD-28).
import * as vscode from 'vscode';
import type { FlowDocument } from '../../core/flow/types';
import { SECRET } from '../../core/import/secrets';
import { inputPrompt, inputSuggestion } from '../../core/run/prompt';

export const inputsKey = (flowId: string) => `afd.inputs.${flowId}`;

export function parseInput(type: string | undefined, text: string): unknown {
  const t = text.trim();
  switch (type) {
    case 'host_list':
      return t
        .split(/[,\s]+/)
        .map((s) => s.trim())
        .filter(Boolean);
    case 'integer':
      return Number(t);
    case 'boolean':
      return /^(true|yes|1)$/i.test(t);
    case 'list':
    case 'dict':
      try {
        return JSON.parse(t);
      } catch {
        return t;
      }
    default:
      return t;
  }
}

function showInput(value: unknown): string {
  if (Array.isArray(value)) return value.join(', ');
  if (value !== null && typeof value === 'object') return JSON.stringify(value);
  return value === undefined ? '' : String(value);
}

/**
 * Flow inputs: given values, else remembered ones (per flow, this workspace), else prompted. A
 * skeleton run (`check`) suggests localhost for hosts nobody gave yet (AFD-71).
 */
export async function collectInputs(
  doc: FlowDocument,
  given: Record<string, unknown> | undefined,
  state: vscode.Memento,
  check = false,
): Promise<Record<string, unknown> | undefined> {
  const remembered = state.get<Record<string, unknown>>(inputsKey(doc.flow.id), {});
  const values: Record<string, unknown> = {};
  for (const [name, field] of Object.entries(doc.flow.inputs ?? {})) {
    if (given && name in given) {
      values[name] = given[name];
      continue;
    }
    if (given) {
      if (field?.default !== undefined) values[name] = field.default;
      continue;
    }
    const needed = field?.required || field?.type === 'host_list';
    if (!needed) {
      if (field?.default !== undefined) values[name] = remembered[name] ?? field.default;
      continue;
    }
    // Secret-looking inputs (an imported vault value or prompt, AFD-28) are typed hidden.
    const secret = SECRET.test(name);
    const text = await vscode.window.showInputBox({
      title: `Run ${doc.flow.name}: input "${name}"`,
      prompt: inputPrompt(field?.type, secret, check, field?.description),
      value: secret ? '' : showInput(inputSuggestion(field, remembered[name], check)),
      password: secret,
      ignoreFocusOut: true,
      validateInput: (v) => (v.trim() ? undefined : 'Required'),
    });
    if (text === undefined) return undefined;
    values[name] = parseInput(field?.type, text);
  }
  // Remembered for the next run, except secrets: they are asked each time and never stored.
  const keep = Object.fromEntries(Object.entries(values).filter(([k]) => !SECRET.test(k)));
  const old = Object.fromEntries(Object.entries(remembered).filter(([k]) => !SECRET.test(k)));
  await state.update(inputsKey(doc.flow.id), { ...old, ...keep });
  return values;
}

export { targetsOf } from '../../core/run/launch';

// What the Flows view says about each flow (AFD-86, wave 8 group D): its problems and the state of
// its generated code, so a repository's health shows without opening every flow (round 1: P16, T7
// given up). The code state uses the same write plan a save does (ADR-0009), so "edited by hand"
// here is what a save would leave alone. Pure, with the generated folder read through GeneratedDir.

import { type GeneratedDir, planGenerated } from '../engine/writePlan';
import { parseFlow } from '../flow/document';
import type { SchemaValidator } from '../flow/schema';
import { validateFlow } from '../flow/validate';

export type CodeState = 'current' | 'out of date' | 'edited by hand' | 'no code yet' | 'blocked';

export interface FlowFacts {
  name: string;
  key: string;
  errors: number;
  warnings: number;
  code: CodeState;
  /** Generated files edited by hand (a save leaves them alone). */
  kept: string[];
  /** The flow does not parse. */
  broken?: string;
}

export async function flowFacts(
  text: string,
  schema: SchemaValidator,
  dir: GeneratedDir,
  options: { source: string; root?: string },
): Promise<FlowFacts> {
  const parsed = parseFlow(text);
  const doc = parsed.doc;
  if (!doc)
    return {
      name: options.source.replace(/\.flow\.ya?ml$/, ''),
      key: '',
      errors: 1,
      warnings: 0,
      code: 'blocked',
      kept: [],
      broken: parsed.errors[0]?.message ?? 'The file does not parse',
    };
  const findings = validateFlow(doc, schema(doc)).findings;
  const errors = findings.filter((f) => f.severity === 'error').length;
  const warnings = findings.filter((f) => f.severity === 'warning').length;
  const base = { name: doc.flow.name, key: doc.flow.key, errors, warnings };
  if (errors > 0) return { ...base, code: 'blocked', kept: [] };
  const plan = await planGenerated(text, schema, dir, options);
  if (plan.kept.length > 0) return { ...base, code: 'edited by hand', kept: plan.kept };
  if ((await dir.list()).length === 0) return { ...base, code: 'no code yet', kept: [] };
  const stale = plan.write.length > 0 || plan.remove.length > 0;
  return { ...base, code: stale ? 'out of date' : 'current', kept: [] };
}

/** The view's description of a flow: problems first, then the code when it needs a look. */
export function factsLine(f: FlowFacts): string {
  const n = (count: number, one: string) => `${count} ${one}${count === 1 ? '' : 's'}`;
  const parts = [
    f.broken ? 'does not parse' : f.errors ? n(f.errors, 'error') : '',
    !f.broken && f.warnings ? n(f.warnings, 'warning') : '',
    f.code === 'out of date'
      ? 'code out of date'
      : f.code === 'edited by hand'
        ? 'code edited by hand'
        : f.code === 'no code yet'
          ? 'no code yet'
          : '',
  ].filter(Boolean);
  return parts.join(' · ');
}

/** What each state means, for the view's tooltip (round 1: "edited by hand" was not understood). */
export const CODE_MEANING: Record<CodeState, string> = {
  current: 'The generated playbooks match the flow.',
  'out of date':
    'The generated playbooks do not match the flow yet: saving the flow (or Generate Code) writes them.',
  'edited by hand':
    'A generated playbook was changed in a text editor, so saving the flow leaves it alone. Generate Code asks before it writes over the change.',
  'no code yet': 'No playbook was generated for this flow yet: saving it writes them.',
  blocked: 'The flow has errors, so no code is generated until they are fixed.',
};

/** A folder of the Flows view: its subfolders and the flows in it. */
export interface FlowFolder {
  name: string;
  /** Path relative to the workspace folder, `/`-separated; empty at the top. */
  path: string;
  folders: FlowFolder[];
  /** Relative paths of the flow files. */
  flows: string[];
}

/**
 * The flows by folder. A folder that only holds its own flow (`flows/hello/hello.flow.yaml`, the
 * New Flow layout) does not make a level of its own: the flow sits in the folder above.
 */
export function flowTree(paths: readonly string[]): FlowFolder {
  const root: FlowFolder = { name: '', path: '', folders: [], flows: [] };
  for (const path of [...paths].sort((a, b) => a.localeCompare(b))) {
    const parts = path.split('/');
    const file = parts.pop() ?? path;
    const key = file.replace(/\.flow\.ya?ml$/, '');
    if (parts.at(-1) === key) parts.pop();
    let at = root;
    for (const name of parts) {
      let next = at.folders.find((f) => f.name === name);
      if (!next) {
        next = { name, path: at.path ? `${at.path}/${name}` : name, folders: [], flows: [] };
        at.folders.push(next);
      }
      at = next;
    }
    at.flows.push(path);
  }
  return root;
}

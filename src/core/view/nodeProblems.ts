// A node's problems for its Details (AFD-44): which tab each one belongs to, and the problem a
// field shows under itself. Findings carry the node's path in the file plus the field they are about.

import type { FlowCommand } from '../flow/commands';
import { enclosing } from '../flow/dataRefs';
import { factSource } from '../flow/facts';
import type { FlowModel } from '../flow/model';
import type { FlowNode, Ulid } from '../flow/types';
import type { Finding } from '../flow/validate';
import type { Path } from '../yaml/parse';

export type ProblemTab = 'general' | 'binding' | 'io' | 'ports' | 'execution';

export interface NodeProblem {
  finding: Finding;
  tab: ProblemTab;
  /** The node field it is about (`key`, `settings.timeout`), when one. */
  field?: string;
}

const TAB_OF: Record<string, ProblemTab> = {
  impl: 'binding',
  inputs: 'io',
  outputs: 'io',
  settings: 'execution',
  ports: 'ports',
};

/** The findings about node `id` at `nodePath`, each with its tab and field. */
export function nodeProblems(
  findings: readonly Finding[],
  id: Ulid,
  nodePath: Path,
): NodeProblem[] {
  return findings
    .filter((f) => f.node === id)
    .map((finding) => {
      const inNode =
        finding.path.length > nodePath.length &&
        nodePath.every((seg, i) => finding.path[i] === seg);
      const rest = inNode ? finding.path.slice(nodePath.length).map(String) : [];
      const head = rest[0];
      const tab: ProblemTab = finding.port ? 'ports' : (head && TAB_OF[head]) || 'general';
      const field = head === 'settings' && rest[1] ? `settings.${rest[1]}` : head;
      return { finding, tab, ...(field ? { field } : {}) };
    });
}

/** The first problem about a field, to show under it, in the node's own words (AFD-336). */
export function fieldProblem(
  problems: readonly NodeProblem[],
  field: string,
  node?: Pick<FlowNode, 'title' | 'key'>,
): string | undefined {
  const found = problems.find((p) => p.field === field)?.finding;
  return found && (node ? ownWords(found, node) : found.message);
}

/**
 * AFD-336: a finding as the node's own Details show it. The flow-wide lists need the node's name;
 * its own panel does not: the finding's brief where it has one, else the message without the name.
 */
export function ownWords(finding: Finding, node: Pick<FlowNode, 'title' | 'key'>): string {
  if (finding.brief) return finding.brief;
  const names = [node.title, node.key].filter((n): n is string => !!n).map((n) => `"${n}"`);
  let text = finding.message;
  for (const name of names) {
    if (text.startsWith(`${name} `) || text.startsWith(`${name}:`)) {
      text = text.slice(name.length).replace(/^:?\s*/, '');
      break;
    }
    // `Open fail port: "Name" · failed_hosts …`
    const mid = `: ${name} · `;
    if (text.includes(mid)) {
      text = text.replace(mid, ': ');
      break;
    }
  }
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : finding.message;
}

/** A one-click fix for a finding on a node's own panel (AFD-336). */
export interface ProblemFix {
  label: string;
  title: string;
  command: FlowCommand;
}

const READS = new Set(['binding-unknown-var', 'setting-unknown-var']);

/**
 * AFD-336: Add as input, for a variable a step reads that is not one of its inputs: from the flow
 * input, the enclosing subflow's input or the earlier step that has it as an output; a set_fact
 * becomes that step's output too (useFact). A name nothing in the flow sets is an input without a
 * source and is set outside the flow. A fact set inside an earlier subflow has no one-click fix:
 * the @ picker lifts it.
 */
export function problemFix(model: FlowModel, finding: Finding): ProblemFix | undefined {
  const name = finding.subject;
  const at = finding.node ? model.nodes.get(finding.node) : undefined;
  if (!READS.has(finding.code) || !name || !at || at.node.inputs?.[name]) return undefined;
  const node = at.node;
  const label = 'Add as input';
  const input = (from: string): ProblemFix => ({
    label,
    title: `Add ${name} as an input of this step, from ${from}`,
    command: {
      kind: 'setContractField',
      target: node.id,
      side: 'inputs',
      name,
      field: { type: 'any', from },
    },
  });
  if (model.doc.flow?.inputs && name in model.doc.flow.inputs) return input(`flow.${name}`);
  for (const sub of enclosing(model, at.level))
    if (sub.inputs && name in sub.inputs) return input(`${sub.key}.${name}`);
  const source = factSource(model, node, name);
  if (source?.how === 'output') return input(`${source.node.key}.${name}`);
  if (source?.how === 'set_fact')
    return {
      label,
      title: `Add ${name} as an input of this step, from "${source.node.title}", which sets it`,
      command: { kind: 'useFact', reader: node.id, setter: source.node.id, name },
    };
  if (source) return undefined;
  return {
    label,
    title: `Add ${name} as an input of this step. Nothing in the flow sets it, so it is marked as set outside the flow (inventory or extra vars)`,
    command: { kind: 'addOutsideInput', node: node.id, name },
  };
}

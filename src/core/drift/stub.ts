// Code from the design (M6, D-29 "design without code"): a role stub for an unbound node and
// meta/argument_specs.yml from a node's input contract (the spec generation deferred from M5).
import { type Out, type OutMap, writeBlock } from '../engine/yamlWriter';
import type { ContractField, ContractType, FlowHeader, FlowNode } from '../flow/types';
import type { TextEdit } from '../yaml/edits';
import { setIn } from '../yaml/ops';
import type { YamlValue } from '../yaml/render';
import { YamlTransaction } from '../yaml/transaction';

/** Ansible role names are identifiers: node keys with underscores. */
export function roleName(key: string): string {
  return key.replaceAll(/[^A-Za-z0-9_]/g, '_');
}

const SPEC: Record<ContractType, OutMap> = {
  string: { type: 'str' },
  integer: { type: 'int' },
  boolean: { type: 'bool' },
  list: { type: 'list', elements: 'str' },
  dict: { type: 'dict' },
  host_list: { type: 'list', elements: 'str' },
  any: { type: 'raw' },
};

const PLACEHOLDER: Record<ContractType, Out> = {
  string: 'TODO',
  integer: 0,
  boolean: false,
  list: [],
  dict: {},
  host_list: [],
  any: 'TODO',
};

function option(name: string, field: ContractField): OutMap {
  const o: OutMap = { ...SPEC[field.type ?? 'any'] };
  if (field.required) o.required = true;
  if (field.default !== undefined) o.default = field.default as Out;
  o.description = field.from ? `From ${field.from} in the flow` : `Flow input contract: ${name}`;
  return o;
}

/** The argument_specs entry point for a node's inputs. */
export function specEntry(node: FlowNode): OutMap {
  const options = Object.fromEntries(
    Object.entries(node.inputs ?? {}).map(([name, field]) => [name, option(name, field)]),
  );
  return {
    short_description: node.title,
    ...(node.intent ? { description: node.intent.trim() } : {}),
    options: Object.keys(options).length > 0 ? options : {},
  };
}

export function argumentSpecsText(node: FlowNode, entry = 'main'): string {
  const head = `# Argument specs written by Ansible Flow Designer from node [${node.key}] ${node.title}.`;
  return `${[head, '---', ...writeBlock({ argument_specs: { [entry]: specEntry(node) } }, 0)].join('\n')}\n`;
}

/** Files of a role stub (repository-relative), for a node that has no code yet. */
export function roleStub(
  node: FlowNode,
  header: Pick<FlowHeader, 'key' | 'name'>,
  role: string,
): { path: string; text: string }[] {
  const tasks: Out[] = [
    {
      name: `TODO ${node.title}`,
      'ansible.builtin.debug': {
        msg: `TODO: ${(node.intent || node.title).replaceAll(/\s+/g, ' ').trim()}`,
      },
    },
  ];
  const outputs = Object.entries(node.outputs ?? {});
  if (outputs.length > 0)
    tasks.push({
      name: 'Outputs the flow reads',
      'ansible.builtin.set_fact': Object.fromEntries(
        outputs.map(([name, f]) => [name, (f?.default as Out) ?? PLACEHOLDER[f?.type ?? 'any']]),
      ),
    });
  const main = [
    `# Role stub written by Ansible Flow Designer for node [${node.key}] ${node.title}`,
    `# of flow ${header.name} (${header.key}). Replace the TODO with the real tasks.`,
    '---',
    ...writeBlock(tasks, 0),
  ];
  return [
    { path: `roles/${role}/tasks/main.yml`, text: `${main.join('\n')}\n` },
    { path: `roles/${role}/meta/argument_specs.yml`, text: argumentSpecsText(node) },
  ];
}

/**
 * meta/argument_specs.yml with an entry point for the node added, as minimal edits of the existing
 * file (its comments and formatting stay); undefined when the entry point exists.
 */
export function addSpecEntry(
  text: string,
  node: FlowNode,
  entry = 'main',
): { edits: TextEdit[]; text: string } | undefined {
  const tx = new YamlTransaction(text);
  const current = tx.current.doc.toJS() as { argument_specs?: Record<string, unknown> } | null;
  if (current?.argument_specs?.[entry]) return undefined;
  const value = specEntry(node) as unknown as YamlValue;
  if (current?.argument_specs) tx.apply((f) => setIn(f, ['argument_specs', entry], value));
  else tx.apply((f) => setIn(f, ['argument_specs'], { [entry]: value }));
  return { edits: tx.edits(), text: tx.text };
}

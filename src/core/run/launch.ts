// The launch dialog (AFD-82, wave 8 group B): a run's inputs, targets and confirmation in one
// place in the designer, instead of an input box per input and a modal. Pure: the host gathers the
// facts and runs, the webview shows the fields, and both use these to read and say the same thing.
import { parse as parseYaml } from 'yaml';
import type { ContractField, FlowDocument } from '../flow/types';
import { SECRET } from '../import/secrets';
import { inputSuggestion } from './prompt';

/** A flow input as the dialog shows it. */
export interface LaunchField {
  name: string;
  type: ContractField['type'] | undefined;
  required: boolean;
  /** Secret-looking (AFD-28): typed hidden, never remembered, never in the webview's state. */
  secret: boolean;
  /** The text the field starts with: remembered, else the default, else a suggestion. */
  text: string;
  /** The host list the start node runs on (`targets`). */
  targets?: boolean;
}

/** An input's value as text in a field (the reverse of `parseInput`). */
export function inputText(value: unknown): string {
  if (Array.isArray(value))
    return value.map((v) => (typeof v === 'string' ? v : JSON.stringify(v))).join(', ');
  if (value !== null && typeof value === 'object') return JSON.stringify(value);
  return value === undefined ? '' : String(value);
}

/**
 * The fields of a run of this flow: required inputs and host lists first (what the prompts asked),
 * then the optional ones with what they will be.
 */
export function launchFields(
  doc: FlowDocument,
  remembered: Record<string, unknown>,
  check: boolean,
): LaunchField[] {
  const out: LaunchField[] = [];
  for (const [name, field] of Object.entries(doc.flow.inputs ?? {})) {
    const secret = SECRET.test(name);
    out.push({
      name,
      type: field?.type,
      required: !!field?.required || field?.type === 'host_list',
      secret,
      text: secret ? '' : inputText(inputSuggestion(field, remembered[name], check)),
      ...(field?.targets ? { targets: true } : {}),
    });
  }
  return out.sort((a, b) => Number(b.required) - Number(a.required));
}

/**
 * What a field's text means for its type (AFD-82: round 1, W10). A host list or a list takes
 * comma-separated items or a JSON list; a dict takes JSON or YAML. Text that does not read as the
 * type is a problem, not a silent string.
 */
export function parseInput(
  type: string | undefined,
  text: string,
): { value: unknown } | { error: string } {
  const t = text.trim();
  switch (type) {
    case 'host_list':
      return {
        value: t
          .split(/[,\s]+/)
          .map((s) => s.trim())
          .filter(Boolean),
      };
    case 'integer':
      return /^-?[0-9]+$/.test(t) ? { value: Number(t) } : { error: 'a whole number' };
    case 'boolean':
      if (/^(true|yes|1)$/i.test(t)) return { value: true };
      if (/^(false|no|0)$/i.test(t)) return { value: false };
      return { error: 'true or false' };
    case 'list': {
      if (t.startsWith('[')) {
        try {
          const v = JSON.parse(t);
          return Array.isArray(v) ? { value: v } : { error: 'a list' };
        } catch {
          return { error: 'a JSON list, or items separated by commas' };
        }
      }
      return {
        value: t
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
      };
    }
    case 'dict': {
      if (!t) return { value: {} };
      try {
        const v = t.startsWith('{') ? JSON.parse(t) : parseYaml(t);
        return v && typeof v === 'object' && !Array.isArray(v)
          ? { value: v }
          : { error: 'key: value pairs, as YAML or JSON' };
      } catch {
        return { error: 'key: value pairs, as YAML or JSON' };
      }
    }
    default:
      return { value: t };
  }
}

/** The parsed value, short, as the dialog shows it under a field. */
export function parsedPreview(type: string | undefined, text: string): string {
  const r = parseInput(type, text);
  if ('error' in r) return `Expected ${r.error}`;
  if (Array.isArray(r.value))
    return r.value.length === 0
      ? 'An empty list'
      : `${r.value.length} item${r.value.length === 1 ? '' : 's'}: ${r.value.map((v) => JSON.stringify(v)).join(', ')}`;
  return JSON.stringify(r.value);
}

/** Inputs from the dialog's texts; the first field that does not read, by name. */
export function readFields(
  fields: readonly LaunchField[],
  texts: Record<string, string>,
): { inputs: Record<string, unknown> } | { error: string; field: string } {
  const inputs: Record<string, unknown> = {};
  for (const f of fields) {
    const text = texts[f.name] ?? f.text;
    if (!text.trim()) {
      if (f.required) return { error: `${f.name} is required`, field: f.name };
      continue;
    }
    const r = parseInput(f.type, text);
    if ('error' in r) return { error: `${f.name}: expected ${r.error}`, field: f.name };
    inputs[f.name] = r.value;
  }
  return { inputs };
}

/**
 * The inputs to count the hosts with while the dialog is filled in (AFD-91): every field that
 * reads, the others left out. Only a host list that does not read holds the count back, since the
 * hosts come from the host lists. Round 2 (S5): with another required input still empty, the
 * dialog kept "devices is required" from when it opened, and Run disabled, after devices was set.
 */
export function checkInputs(
  fields: readonly LaunchField[],
  texts: Record<string, string>,
): { inputs: Record<string, unknown> } | { error: string; field: string } {
  const inputs: Record<string, unknown> = {};
  for (const f of fields) {
    const r = readFields([f], texts);
    if ('inputs' in r) Object.assign(inputs, r.inputs);
    else if (f.type === 'host_list') return r;
  }
  return { inputs };
}

/** A run as the dialog starts it: its fields, the inventory's groups, the facts for the start values. */
export interface LaunchPlan {
  /** Single-use and kept by the host (10 minutes): only Run in this dialog skips the prompts. */
  token: string;
  mode: 'check' | 'real';
  flow: string;
  fields: LaunchField[];
  /** The inventory's groups, offered for host lists. */
  groups: string[];
  facts?: LaunchFacts;
  /** Why there are no facts (the targets do not read, nothing matches, no answer). */
  factsError?: string;
  /** Ask for the vault password in the dialog. */
  vault: boolean;
  environment: string;
}

/** A target the run touches beyond the flow targets: nodes with an inventory_target (AFD-14). */
export interface TargetUse {
  /** The pattern with flow inputs filled in; undefined when it needs Jinja beyond that. */
  pattern?: string;
  declared: string;
  nodes: string[];
  count?: number;
  prod: string[];
}

/** What a run would touch, as the host found it in the inventory just now. */
export interface LaunchFacts {
  sources: string[];
  count: number;
  hosts: string[];
  unknown: string[];
  uses: TargetUse[];
  /** Production-looking groups and hosts, the targets' and the inventory_targets' together. */
  prod: string[];
  vault: boolean;
  environment: string;
}

/** Confirmation lines for the targets: pattern, host count and the nodes that run there. */
export function targetLines(uses: TargetUse[]): string[] {
  return uses.map((u) => {
    const where = u.nodes.map((k) => `[${k}]`).join(', ');
    const hosts =
      u.count === undefined
        ? 'resolved at run time'
        : u.count === 0
          ? 'matches no host, so those nodes fail every arriving host'
          : `${u.count} host(s)`;
    return `Also on inventory_target ${u.pattern ?? u.declared}: ${hosts} (${where})`;
  });
}

/** Hosts the run's inventory_targets add. */
export const extraHosts = (f: LaunchFacts) => f.uses.reduce((n, u) => n + (u.count ?? 0), 0);

/** The real-run question: the same words in the modal and the dialog. */
export function realRunQuestion(flowName: string, f: LaunchFacts): string {
  const extra = extraHosts(f);
  return `Run "${flowName}" for real on ${f.count} host(s)${extra ? ` and ${extra} inventory_target host(s)` : ''}?`;
}

/** The real-run confirmation's lines (the modal's detail, the dialog's facts). */
export function realRunLines(f: LaunchFacts): string[] {
  const shown = f.hosts.slice(0, 8).join(', ') + (f.count > 8 ? ', …' : '');
  return [
    'This is not check mode: bound nodes change the devices.',
    `Inventory: ${f.sources.join(', ')}`,
    `Hosts: ${f.count} (${shown})`,
    f.unknown.length ? `Not in the inventory: ${f.unknown.join(', ')}` : '',
    ...targetLines(f.uses),
    f.prod.length
      ? `Production-looking: ${f.prod.slice(0, 8).join(', ')}`
      : 'No production-looking groups or hosts',
    `Environment: ${f.environment}`,
  ].filter(Boolean);
}

/**
 * Whether the facts at launch are those the dialog showed (AFD-82): otherwise the person has not
 * seen what the run will touch, and the dialog shows them again before anything runs.
 */
export function sameFacts(a: LaunchFacts, b: LaunchFacts): boolean {
  const key = (f: LaunchFacts) =>
    JSON.stringify([
      f.count,
      [...f.hosts].sort(),
      [...f.unknown].sort(),
      [...f.prod].sort(),
      f.uses.map((u) => [u.pattern ?? u.declared, u.count ?? null]),
      f.environment,
    ]);
  return key(a) === key(b);
}

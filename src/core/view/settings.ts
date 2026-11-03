// The node settings the properties page edits (Execution tab), and how typed text becomes a
// setting value (AFD-34: out of the component, shared and tested). Settings the flow models as
// fields; other task keywords live in impl.keywords (AFD-26).
import type { FlowNode, NodeSettings, NodeType } from '../flow/types';

export type SettingKey = keyof NodeSettings;

/** The Execution tab's groups, in order (AFD-44). */
export const SETTING_GROUPS = ['Targeting', 'Privilege', 'Timing', 'Tags'] as const;
export type SettingGroup = (typeof SETTING_GROUPS)[number];

export interface SettingField {
  key: SettingKey;
  label: string;
  kind: 'text' | 'int' | 'bool' | 'list';
  help: string;
  group: SettingGroup;
  /** The flow format that has the setting (AFD-52); older formats do not show it. */
  format?: number;
  /** The last flow format that has it on a node (AFD-52: credential and EE moved to the flow). */
  formatMax?: number;
  /** Only on these node types (default: every type the Execution tab shows). */
  types?: readonly NodeType[];
}

export const EXECUTION_SETTINGS: readonly SettingField[] = [
  {
    key: 'timeout',
    group: 'Timing',
    label: 'Timeout',
    kind: 'text',
    help: '30s, 15m, 1h30m: the task timeout keyword (timeout port)',
  },
  {
    key: 'retries',
    group: 'Timing',
    label: 'Retries',
    kind: 'int',
    help: 'Module nodes retry until the result succeeds, or until Until holds',
  },
  {
    key: 'until',
    group: 'Timing',
    label: 'Until',
    kind: 'text',
    help: 'Poll until this Jinja test holds',
  },
  {
    key: 'delay',
    group: 'Timing',
    label: 'Delay',
    kind: 'int',
    help: 'Seconds between retries (Ansible default 5)',
  },
  {
    key: 'serial',
    group: 'Targeting',
    label: 'Serial',
    kind: 'text',
    help: 'Hosts per batch: a number or a percentage',
  },
  {
    key: 'rolling',
    group: 'Targeting',
    label: 'Rolling batch',
    kind: 'text',
    help: 'Hosts per batch through every step inside, one batch after another: a number or a percentage',
    types: ['subflow'],
  },
  {
    key: 'max_fail_percentage',
    group: 'Targeting',
    label: 'Max fail percentage',
    kind: 'int',
    help: 'Stop the flow when more hosts fail',
  },
  {
    key: 'become',
    group: 'Privilege',
    label: 'Become',
    kind: 'bool',
    help: 'Run with privilege escalation; on a subflow, the steps inside too (format 2)',
  },
  {
    key: 'become_user',
    group: 'Privilege',
    label: 'Become user',
    kind: 'text',
    help: 'Whom to become (default root); on a subflow, the steps inside too',
    format: 2,
  },
  {
    key: 'tags',
    group: 'Tags',
    label: 'Tags',
    kind: 'list',
    help: 'Extra play tags, comma separated',
  },
  {
    key: 'credential',
    // Format 2 sets them on the flow (AFD-52).
    formatMax: 1,
    group: 'Privilege',
    label: 'Credential (AWX)',
    kind: 'text',
    help: 'AWX credential name; local runs use the environment',
  },
  {
    key: 'inventory_target',
    group: 'Targeting',
    label: 'Inventory target',
    kind: 'text',
    help: 'Run the work on these hosts (an inventory pattern) instead of the arriving ones; steps inside a subflow inherit it',
  },
];

/** Steps that run no task of their own: their play takes only these (AFD-71). */
const ROUTING_KEYS: readonly SettingKey[] = [
  'serial',
  'become',
  'become_user',
  'tags',
  'credential',
];
/** What a subflow with steps inside uses: the rest belongs on the steps (AFD-71). */
const LEVEL_KEYS: readonly SettingKey[] = [
  'rolling',
  'become',
  'become_user',
  'inventory_target',
  'credential',
];

/**
 * Whether the generated code uses the setting on this node (AFD-71), so the Execution tab shows
 * only those. Decision, approval, parallel and join plays route hosts and run no task; an approval's
 * timeout is the AWX approval's. A subflow with steps inside hands privilege and targets to them.
 */
export function appliesTo(field: SettingField, node: Pick<FlowNode, 'type' | 'subflow'>): boolean {
  if (field.types && !field.types.includes(node.type)) return false;
  if (node.type === 'subflow' && (node.subflow?.nodes?.length ?? 0) > 0)
    return LEVEL_KEYS.includes(field.key);
  if (node.type === 'approval' && field.key === 'timeout') return true;
  if (['decision', 'approval', 'parallel', 'join'].includes(node.type))
    return ROUTING_KEYS.includes(field.key);
  return true;
}

/** Why typed text is not a valid value for the field, or undefined. */
export function settingProblem(field: SettingField, text: string): string | undefined {
  const t = text.trim();
  if (field.kind === 'int' && t && !/^[0-9]+$/.test(t)) return 'A whole number';
  if (field.key === 'rolling' && t && !/^[1-9][0-9]*%?$/.test(t))
    return 'A number of hosts, or a percentage like 25%';
  return undefined;
}

/** The setting value for typed text: null clears it; serial takes a plain number as a number. */
export function settingValue(field: SettingField, text: string): unknown {
  const t = text.trim();
  if (!t) return null;
  if (field.kind === 'int') return Number(t);
  if (field.kind === 'list')
    return t
      .split(',')
      .map((x) => x.trim())
      .filter(Boolean);
  return /^[0-9]+$/.test(t) && (field.key === 'serial' || field.key === 'rolling') ? Number(t) : t;
}

/** A setting value as the text its field shows. */
export function settingText(value: unknown): string {
  return Array.isArray(value) ? value.join(', ') : value === undefined ? '' : String(value);
}

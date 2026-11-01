// The node settings the properties page edits (Execution tab), and how typed text becomes a
// setting value (AFD-34: out of the component, shared and tested). Settings the flow models as
// fields; other task keywords live in impl.keywords (AFD-26).
import type { NodeSettings } from '../flow/types';

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
    help: 'Run with privilege escalation',
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

/** Why typed text is not a valid value for the field, or undefined. */
export function settingProblem(field: SettingField, text: string): string | undefined {
  return field.kind === 'int' && text.trim() && !/^[0-9]+$/.test(text.trim())
    ? 'A whole number'
    : undefined;
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
  return /^[0-9]+$/.test(t) && field.key === 'serial' ? Number(t) : t;
}

/** A setting value as the text its field shows. */
export function settingText(value: unknown): string {
  return Array.isArray(value) ? value.join(', ') : value === undefined ? '' : String(value);
}

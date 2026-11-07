// The node settings the properties page edits (Execution tab), and how typed text becomes a
// setting value (AFD-34: out of the component, shared and tested). Settings the flow models as
// fields; other task keywords live in impl.keywords (AFD-26).
import { duration, durationSeconds, spokenDuration } from '../flow/duration';
import type { FlowNode, NodeSettings, NodeType } from '../flow/types';

export type SettingKey = keyof NodeSettings;

/** The Execution tab's groups, in order (AFD-44). */
export const SETTING_GROUPS = ['Targeting', 'Privilege', 'Timing', 'Tags'] as const;
export type SettingGroup = (typeof SETTING_GROUPS)[number];

export interface SettingField {
  key: SettingKey;
  label: string;
  /** `seconds`: typed as a duration (`10s`, `1m`), kept as whole seconds (AFD-111). */
  kind: 'text' | 'int' | 'seconds' | 'bool' | 'list';
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
    // AFD-103 (round 3: R2): "15 seconds apart" went here; it is the limit of one try.
    help: 'Limit for one try: 30s, 15m, 1h30m (hosts that run over take the timeout port)',
  },
  {
    key: 'retries',
    group: 'Timing',
    label: 'Retries',
    kind: 'int',
    // AFD-111 (round 4: Q1): Ansible runs the task once, then retries it up to this many times.
    help: 'Tries again up to this many times after the first try: until Until holds, or until the step succeeds',
  },
  {
    key: 'until',
    group: 'Timing',
    label: 'Until',
    kind: 'text',
    help: 'Try again until this test holds (Jinja, no braces)',
  },
  {
    key: 'delay',
    group: 'Timing',
    label: 'Delay',
    // AFD-111 (round 4: Q2): written like Timeout; Ansible's delay is a number of seconds.
    kind: 'seconds',
    help: 'Wait between tries: 10s, 1m, or a number of seconds (Ansible default 5s)',
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

/** Typed seconds: `10s`, `1m`, `90`; `0` too, where a timeout has no zero. */
function secondsOf(text: string): number | undefined {
  return /^0+\s*s?$/i.test(text.trim()) ? 0 : durationSeconds(text);
}

/** Why typed text is not a valid value for the field, or undefined. */
export function settingProblem(field: SettingField, text: string): string | undefined {
  const t = text.trim();
  if (field.kind === 'int' && t && !/^[0-9]+$/.test(t)) return 'A whole number';
  if (field.kind === 'seconds' && t && secondsOf(t) === undefined)
    return 'A duration: 10s, 1m, 1m30s, or a number of seconds';
  // AFD-103: what codegen cannot read it leaves out of the task without a word.
  if (field.key === 'timeout' && t && durationSeconds(t) === undefined)
    return 'A duration: 30s, 15m, 1h30m';
  if (field.key === 'rolling' && t && !/^[1-9][0-9]*%?$/.test(t))
    return 'A number of hosts, or a percentage like 25%';
  return undefined;
}

/** The setting value for typed text: null clears it; serial takes a plain number as a number. */
export function settingValue(field: SettingField, text: string): unknown {
  const t = text.trim();
  if (!t) return null;
  if (field.kind === 'int') return Number(t);
  if (field.kind === 'seconds') return secondsOf(t) ?? null;
  if (field.kind === 'list')
    return t
      .split(',')
      .map((x) => x.trim())
      .filter(Boolean);
  return /^[0-9]+$/.test(t) && (field.key === 'serial' || field.key === 'rolling') ? Number(t) : t;
}

/** A setting value as the text its field shows; seconds as a duration (`10s`, `1m30s`). */
export function settingText(value: unknown, field?: SettingField): string {
  if (field?.kind === 'seconds' && typeof value === 'number') return duration(value);
  return Array.isArray(value) ? value.join(', ') : value === undefined ? '' : String(value);
}

/**
 * How a step's Timing settings combine, in one sentence (AFD-103, round 3: R2): the participant
 * put "15 seconds apart" into Timeout, since nothing said what each field does to the others.
 * Mirrors codegen (core/engine/binding.ts) and ansible-core 2.19 (`task_executor.py`): with
 * Retries or Until the task runs once, then retries up to Retries times (Ansible's default 3),
 * waiting Delay (default 5 s) between tries; Delay alone does nothing; Timeout limits each try.
 * AFD-111 (round 4: Q1, Q3): it counts the first try, and says how long the step can take in all.
 */
export function timingText(s: NodeSettings, result: string): string | undefined {
  const until = s.until?.trim();
  const retries = s.retries;
  const timeout = typeof s.timeout === 'string' ? s.timeout.trim() : s.timeout;
  if (!until && !retries && s.delay === undefined && !timeout) return undefined;
  const parts: string[] = [];
  const limit = timeout !== undefined && timeout !== '' ? durationSeconds(timeout) : undefined;
  const goal = until ? `until ${until}` : `until it succeeds (${result} is succeeded)`;
  let total: number | undefined;
  if (until || retries) {
    const again = retries ?? 3;
    const tries = 1 + Math.max(0, again);
    const apart = typeof s.delay === 'number' ? s.delay : 5;
    const retried = `${again} ${again === 1 ? 'retry' : 'retries'}${retries === undefined ? ", Ansible's default" : ''}`;
    parts.push(
      tries === 1
        ? `Tries once (Retries 0), and fails unless ${until}`
        : `Tries up to ${tries} times (once, then ${retried}), ${spokenDuration(apart)} apart, ${goal}`,
    );
    if (limit !== undefined && tries > 1) total = tries * limit + (tries - 1) * apart;
  } else {
    parts.push('Runs once');
    if (s.delay !== undefined) parts.push('Delay applies only with Retries or Until');
  }
  if (timeout !== undefined && timeout !== '') {
    parts.push(
      limit === undefined
        ? `"${timeout}" is not a duration, so no try has a limit`
        : `each try at most ${timeout}`,
    );
  }
  if (total !== undefined) parts.push(`the step takes at most ${spokenDuration(total)} in all`);
  return `${parts.join('; ')}.`;
}

// The node settings the properties page edits (Execution tab), and how typed text becomes a
// setting value (AFD-34: out of the component, shared and tested). Settings the flow models as
// fields; other task keywords live in impl.keywords (AFD-26).

import type { RefChoice } from '../catalog/draft';
import { duration, durationSeconds, spokenDuration } from '../flow/duration';
import { singleRef, templated } from '../flow/jinja';
import type { FlowDocument, FlowNode, NodeSettings, NodeType } from '../flow/types';

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

/** The settings a step may take at run time (AFD-112, round 4: Q4); see RunTimeSetting. */
export const RUN_TIME_KEYS: readonly SettingKey[] = ['retries', 'delay', 'timeout'];

/**
 * Why typed text is not a valid value for the field, or undefined. AFD-112: Retries, Delay and
 * Timeout also take a template given at run time (`{{ drain_tries }}`), unless `runTime` is false
 * (an approval's timeout, which AWX needs as a number).
 */
export function settingProblem(
  field: SettingField,
  text: string,
  runTime = true,
): string | undefined {
  const t = text.trim();
  const input = runTime && RUN_TIME_KEYS.includes(field.key);
  if (input && templated(t)) return undefined;
  const or = input ? ', or an input with @' : '';
  if (field.kind === 'int' && t && !/^[0-9]+$/.test(t)) return `A whole number${or}`;
  if (field.kind === 'seconds' && t && secondsOf(t) === undefined)
    return `A duration: 10s, 1m, 1m30s, a number of seconds${or}`;
  // AFD-103: what codegen cannot read it leaves out of the task without a word.
  if (field.key === 'timeout' && t && durationSeconds(t) === undefined)
    return `A duration: 30s, 15m, 1h30m${or}`;
  if (field.key === 'rolling' && t && !/^[1-9][0-9]*%?$/.test(t))
    return 'A number of hosts, or a percentage like 25%';
  return undefined;
}

/** The setting value for typed text: null clears it; serial takes a plain number as a number. */
export function settingValue(field: SettingField, text: string): unknown {
  const t = text.trim();
  if (!t) return null;
  // AFD-112: a template is kept as it is; Ansible renders it when the task runs.
  if (RUN_TIME_KEYS.includes(field.key) && templated(t)) return t;
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

/** A Timing value as the sentence reads it (AFD-112): a number, or what is given at run time. */
interface Amount {
  /** The number: the value, or the default of the input it reads. */
  n?: number;
  /** The name of the input it reads, when it is one input. */
  ref?: string;
  /** The template's body, for an expression. */
  expr?: string;
}

function amount(
  v: number | string | undefined,
  read: (text: string) => number | undefined,
  defaultOf?: (name: string) => number | undefined,
): Amount | undefined {
  if (v === undefined || v === '') return undefined;
  if (typeof v === 'number') return { n: v };
  if (!templated(v)) return { n: read(v) };
  const ref = singleRef(v);
  if (ref) return { ref, n: defaultOf?.(ref) };
  return { expr: v.trim().slice(2, -2).trim() };
}

/** "10 s", "drain_delay s", "(drain_wait / 30) | int s", with what follows it in `then`. */
function seconds(a: Amount, then = ''): string {
  const note = a.ref && a.n !== undefined ? ` (${spokenDuration(a.n)} by default)` : '';
  if (a.ref) return `${a.ref} s${then}${note}`;
  if (a.expr) return `${a.expr} s${then}`;
  return `${spokenDuration(a.n ?? 0)}${then}`;
}

/**
 * How a step's Timing settings combine, in one sentence (AFD-103, round 3: R2): the participant
 * put "15 seconds apart" into Timeout, since nothing said what each field does to the others.
 * Mirrors codegen (core/engine/binding.ts) and ansible-core 2.19 (`task_executor.py`): with
 * Retries or Until the task runs once, then retries up to Retries times (Ansible's default 3),
 * waiting Delay (default 5 s) between tries; Delay alone does nothing; Timeout limits each try,
 * and a try that runs over ends the task, with no more tries.
 * AFD-111 (round 4: Q1, Q3): it counts the first try, and says how long the step can take in all.
 * AFD-112 (round 4: Q4): a value given at run time reads by its input, with the input's default
 * (`defaultOf`) for the numbers.
 */
export function timingText(
  s: NodeSettings,
  result: string,
  defaultOf?: (name: string) => number | undefined,
): string | undefined {
  const until = s.until?.trim();
  const timeoutText = typeof s.timeout === 'string' ? s.timeout.trim() : s.timeout;
  if (!until && !s.retries && s.delay === undefined && !timeoutText) return undefined;
  const parts: string[] = [];
  const retries = amount(s.retries, () => undefined, defaultOf);
  const delay = amount(s.delay, () => undefined, defaultOf) ?? { n: 5 };
  const limit = amount(timeoutText, durationSeconds, defaultOf);
  const goal = until ? `until ${until}` : `until it succeeds (${result} is succeeded)`;
  const retrying = !!until || !!s.retries;
  let tries: number | undefined;
  if (retrying) {
    const again = retries ?? { n: 3 };
    tries = again.n !== undefined ? 1 + Math.max(0, again.n) : undefined;
    const apart = seconds(delay, ' apart');
    if (again.expr)
      parts.push(`Tries up to 1 + ${again.expr} times, worked out at run time, ${apart}, ${goal}`);
    else if (again.ref)
      parts.push(
        `Tries up to ${again.ref} + 1 times (${tries !== undefined ? `${tries} with its default ${again.n}` : `${again.ref} is given at run time`}), ${apart}, ${goal}`,
      );
    else if (tries === 1) parts.push(`Tries once (Retries 0), and fails unless ${until}`);
    else
      parts.push(
        `Tries up to ${tries} times (once, then ${again.n} ${again.n === 1 ? 'retry' : 'retries'}${retries === undefined ? ", Ansible's default" : ''}), ${apart}, ${goal}`,
      );
  } else {
    parts.push('Runs once');
    if (s.delay !== undefined) parts.push('Delay applies only with Retries or Until');
  }
  if (limit) {
    const over = retrying && tries !== 1 ? ', and a try that runs over ends the step' : '';
    if (limit.ref || limit.expr) parts.push(`each try at most ${seconds(limit)}${over}`);
    else if (limit.n === undefined)
      parts.push(`"${timeoutText}" is not a duration, so no try has a limit`);
    else parts.push(`each try at most ${timeoutText}${over}`);
  }
  if (
    retrying &&
    tries !== undefined &&
    tries > 1 &&
    limit?.n !== undefined &&
    delay.n !== undefined
  ) {
    const total = tries * limit.n + (tries - 1) * delay.n;
    const byDefault = [retries, delay, limit].some((a) => a?.ref);
    parts.push(
      `the step takes at most ${spokenDuration(total)} in all${byDefault ? ' with the defaults' : ''}`,
    );
  }
  return `${parts.join('; ')}.`;
}

/** Input types whose value Ansible can render as a whole number (AFD-112). */
const NUMERIC: readonly string[] = ['integer', 'string', 'any'];

/**
 * The default the sentence reads for an input a Timing setting is given at run time (AFD-112):
 * the step input's own default, else that of the flow input it reads.
 */
export function inputDefaultOf(
  flow: Pick<FlowDocument['flow'], 'inputs'>,
  node: Pick<FlowNode, 'inputs'>,
): (name: string) => number | undefined {
  const whole = (v: unknown) =>
    typeof v === 'number' && Number.isInteger(v)
      ? v
      : typeof v === 'string' && /^[0-9]+$/.test(v.trim())
        ? Number(v)
        : undefined;
  return (name) => {
    const field = node.inputs?.[name];
    if (field?.default !== undefined) return whole(field.default);
    const from = field?.from;
    return from?.startsWith('flow.') ? whole(flow.inputs?.[from.slice(5)]?.default) : undefined;
  };
}

/**
 * What a Timing field's @ list offers (AFD-112): the inputs that can hold a number, a step's
 * own or the flow's, never a step's result or output of another type.
 */
export function timingChoices(
  choices: readonly RefChoice[],
  node: Pick<FlowNode, 'inputs'>,
): RefChoice[] {
  return choices.filter((c) => {
    if (c.fields || c.expose) return false;
    const type = c.field?.type ?? node.inputs?.[c.name]?.type;
    return type === undefined || NUMERIC.includes(type);
  });
}

/** The flow input a Timing setting reads, when it reads one through a step input (AFD-112). */
export function askedInput(
  value: unknown,
  node: Pick<FlowNode, 'inputs'>,
): { input: string; flow: string } | undefined {
  const name = singleRef(value);
  const from = name ? node.inputs?.[name]?.from : undefined;
  return name && from?.startsWith('flow.') ? { input: name, flow: from.slice(5) } : undefined;
}

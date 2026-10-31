// Ansible task keywords on a binding (AFD-26, `impl.keywords`): written on the generated task as
// they are. What the flow models itself (register, tags, become, timeout, retries, until, handlers,
// blocks) is refused here with the place it belongs; the schema allow-lists the rest.
import { exprRefs, refsIn } from './jinja';
import type { ImplBinding } from './types';

/** Keywords a binding may carry. `with_<lookup>` is allowed too (WITH). */
export const ALLOWED_KEYWORDS: readonly string[] = [
  'when',
  'changed_when',
  'failed_when',
  'loop',
  'loop_control',
  'ignore_errors',
  'delegate_to',
  'delegate_facts',
  'run_once',
  'no_log',
  'check_mode',
  'diff',
  'environment',
  'become_user',
  'become_method',
  'become_flags',
  'become_exe',
  'connection',
  'remote_user',
  'port',
  'throttle',
  'async',
  'poll',
  'vars',
  'module_defaults',
  'debugger',
];

export const WITH = /^with_[a-z_]+$/;

/** Jinja tests written without braces. */
export const BARE_KEYWORDS: ReadonlySet<string> = new Set(['when', 'changed_when', 'failed_when']);

/** On include_role these stay on the task; every other keyword goes into `apply` (static roles). */
export const ROLE_TASK_KEYWORDS: ReadonlySet<string> = new Set(['when', 'loop', 'loop_control']);

/** Keywords the flow models itself, with where they go instead. */
export const RESERVED_KEYWORDS: Readonly<Record<string, string>> = {
  name: 'the node title',
  register: 'impl.register',
  tags: 'settings.tags',
  become: 'settings.become',
  timeout: 'settings.timeout',
  retries: 'settings.retries',
  delay: 'settings.delay',
  until: 'settings.until',
  notify: 'a handler step with when: <register> is changed',
  listen: 'a handler step with when: <register> is changed',
  ignore_unreachable: 'the unreachable port',
  block: 'a subflow',
  rescue: 'a failure path from failed_hosts',
  always: 'the always port or a step after both paths',
  action: 'impl.ref and impl.params',
  local_action: 'impl.ref with delegate_to: localhost',
  args: 'impl.params',
  any_errors_fatal: 'settings.max_fail_percentage: 0',
  collections: 'a fully qualified impl.ref',
};

export function isAllowedKeyword(key: string): boolean {
  return ALLOWED_KEYWORDS.includes(key) || WITH.test(key);
}

/** "tags is a setting: use settings.tags", or undefined for an allowed keyword. */
export function keywordProblem(key: string): string | undefined {
  if (isAllowedKeyword(key)) return undefined;
  const instead = RESERVED_KEYWORDS[key];
  return instead
    ? `${key} is modelled by the flow: use ${instead}`
    : `${key} is not a task keyword a binding can carry`;
}

/**
 * What a binding's keywords read: templated values (`loop: "{{ items }}"`), bare tests (`when`),
 * and the names they define themselves (loop variables, `vars` keys), which count as known.
 */
export function keywordReads(impl: ImplBinding | null | undefined): {
  templated: string[];
  bare: string[];
  own: string[];
} {
  const kw = impl?.keywords;
  if (!kw || typeof kw !== 'object') return { templated: [], bare: [], own: [] };
  const templated: string[] = [];
  const bare: string[] = [];
  for (const [k, v] of Object.entries(kw)) {
    if (BARE_KEYWORDS.has(k)) {
      // A list of tests is ANDed; a string with braces is templated anyway.
      for (const t of Array.isArray(v) ? v : [v]) {
        if (typeof t !== 'string') continue;
        if (t.includes('{{')) templated.push(...refsIn(t));
        else bare.push(...exprRefs(t));
      }
    } else templated.push(...refsIn(v));
  }
  const own: string[] = [];
  const control = kw.loop_control;
  if (control && typeof control === 'object') {
    for (const k of ['loop_var', 'index_var'] as const) {
      const name = (control as Record<string, unknown>)[k];
      if (typeof name === 'string' && name) own.push(name);
    }
  }
  if (kw.vars && typeof kw.vars === 'object') own.push(...Object.keys(kw.vars));
  return { templated, bare, own };
}

/** "when", "loop" or "when + loop": what a node card's sub line says about its keywords. */
export function keywordHint(impl: ImplBinding | null | undefined): string {
  const keys = Object.keys(impl?.keywords ?? {});
  return [
    keys.includes('when') ? 'when' : '',
    keys.some((k) => k === 'loop' || WITH.test(k)) ? 'loop' : '',
  ]
    .filter(Boolean)
    .join(' + ');
}

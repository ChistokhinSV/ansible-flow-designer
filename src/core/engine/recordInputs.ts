// AFD-341: the values a step's inputs had for each host in a run. Before a step runs, one set_fact
// task puts what the step gets as vars (its play vars: its inputs, ADR-0011) into `afd_inputs`; the
// afd_events callback turns that result into an `inputs` event, redacted and size-limited, and no
// task result. Ansible renders the values, per host, exactly as the step sees them: nothing is
// evaluated by the designer. ADR-0038, section "Phase 3".
//
// What the task never renders: every input of a `no_log` step, an input with a secret-looking
// name, and an input whose chain origin marks secret (a vaulted default, a secret-looking name on
// the way). Those are written as a constant marker. A value that holds a vaulted value anywhere
// inside it (a Jinja macro walks dicts and lists) becomes another marker, since ansible-core before
// 2.22 hands the plain text of a vaulted value to the callback.
import type { FlowModel } from '../flow/model';
import { inputOrigin, noLog } from '../flow/origin';
import type { FlowNode } from '../flow/types';
import { SECRET } from '../import/secrets';
import type { OutMap } from './yamlWriter';

/** The fact the task sets; the callback reads it from the task's result. */
export const INPUTS_FACT = 'afd_inputs';
/** The end of the task's name (`[<key>] record inputs`): how the callback knows the task. */
export const RECORD_TASK = 'record inputs';
/** The task's name in generated code, as drift and the callback know it. */
export const RECORD_TASK_NAME = /^\[[^\]]*\] record inputs$/;
/** What the callback reads in place of a value it must not record. */
export const INPUT_MARK = {
  secret: '__afd_secret__',
  vault: '__afd_vault__',
  undefined: '__afd_undefined__',
} as const;
/** The environment variable that turns recording off (`0`); unset or anything else: on. */
export const RECORD_ENV = 'AFD_RECORD_INPUTS';

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const VAULT_MACRO =
  '{%- macro afd_vault(x) -%}{%- if x is ansible.builtin.vault_encrypted -%}1' +
  '{%- elif x is mapping -%}{%- for k in x -%}{{ afd_vault(x[k]) }}{%- endfor -%}' +
  '{%- elif x is iterable and x is not string -%}{%- for i in x -%}{{ afd_vault(i) }}{%- endfor -%}' +
  '{%- endif -%}{%- endmacro -%}';

/** Whether an input's value must never be rendered for the record (known from the flow). */
export function secretInput(model: FlowModel, node: FlowNode, name: string): boolean {
  return noLog(node) || SECRET.test(name) || inputOrigin(model, node, name).secret;
}

/**
 * The task that records `node`'s inputs, or none when the step has no input. It is skipped when
 * the run turns recording off, and a failure in it is ignored: recording never changes a run.
 */
export function recordInputsTask(model: FlowModel, node: FlowNode): OutMap | undefined {
  const names = Object.keys(node.inputs ?? {}).filter((n) => NAME.test(n));
  if (names.length === 0) return undefined;
  const entries = names.map((n) => {
    const value = secretInput(model, node, n)
      ? `'${INPUT_MARK.secret}'`
      : `(('${INPUT_MARK.vault}' if afd_vault(${n}) else ${n}) if ${n} is defined else '${INPUT_MARK.undefined}')`;
    return `'${n}': ${value}`;
  });
  const rendered = names.some((n) => !secretInput(model, node, n));
  return {
    name: `[${node.key}] ${RECORD_TASK}`,
    'ansible.builtin.set_fact': {
      [INPUTS_FACT]: `${rendered ? VAULT_MACRO : ''}{{ {${entries.join(', ')}} }}`,
    },
    when: `lookup('ansible.builtin.env', '${RECORD_ENV}') != '0'`,
    ignore_errors: true,
  };
}

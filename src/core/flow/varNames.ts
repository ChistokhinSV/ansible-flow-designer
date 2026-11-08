// Names that become Ansible variables: flow and node inputs and outputs, impl.register (AFD-160).
// ansible-core 2.22 refuses names that are not ASCII identifiers or are Jinja constants (`true`,
// `none`, `not`); cores before it refused every Python keyword. Expressions reading `in` or `is`
// do not parse either, so a name is checked against both lists.

export const VAR_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Python 3 keywords, and the lower-case constants Jinja reads instead of a variable. */
export const RESERVED_NAMES: readonly string[] = [
  'False',
  'None',
  'True',
  'and',
  'as',
  'assert',
  'async',
  'await',
  'break',
  'class',
  'continue',
  'def',
  'del',
  'elif',
  'else',
  'except',
  'false',
  'finally',
  'for',
  'from',
  'global',
  'if',
  'import',
  'in',
  'is',
  'lambda',
  'none',
  'nonlocal',
  'not',
  'or',
  'pass',
  'raise',
  'return',
  'true',
  'try',
  'while',
  'with',
  'yield',
];

const RESERVED = new Set(RESERVED_NAMES);

/** Why a name cannot be an Ansible variable, or undefined when it can. */
export function varNameProblem(name: string): string | undefined {
  if (!VAR_NAME.test(name))
    return `"${name}" is not a variable name: a letter or _, then letters, digits and _`;
  if (RESERVED.has(name)) return `"${name}" is a Python or Jinja keyword, not a variable name`;
  return undefined;
}

// What an import never copies (ADR-0015, AFD-26): AWX's encrypted values, Ansible Vault values and
// anything whose name looks secret. Their names go to the notes; their values never reach the flow,
// a log or a message.

/** AWX's placeholder for an encrypted value. */
export const ENCRYPTED = '$encrypted$';

/** Names that look secret: passwords, tokens, keys, vault material. */
export const SECRET = /pass(word|wd)?|secret|token|api_?key|private_?key|vault/i;

/** A `!vault` value: the ciphertext is dropped when the YAML is read. */
export const VAULT: unique symbol = Symbol('vault');

/** Whether a value holds an encrypted AWX value or an Ansible Vault value anywhere inside it. */
export function holdsSecret(value: unknown): boolean {
  if (value === VAULT) return true;
  if (typeof value === 'string')
    return value.includes(ENCRYPTED) || value.startsWith('$ANSIBLE_VAULT');
  if (Array.isArray(value)) return value.some(holdsSecret);
  if (value && typeof value === 'object') return Object.values(value).some(holdsSecret);
  return false;
}

/** A variable whose value must not be copied: its name looks secret, or its value is encrypted. */
export function isSecret(name: string, value: unknown): boolean {
  return SECRET.test(name) || holdsSecret(value);
}

/**
 * A copy without secret entries; the names of those it left out go to `hidden`. Undefined when
 * nothing is left.
 */
export function cleanVars(
  vars: Record<string, unknown> | undefined,
  hidden: Set<string>,
): Record<string, unknown> | undefined {
  if (!vars) return undefined;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(vars)) {
    if (isSecret(k, v)) hidden.add(k);
    else out[k] = v;
  }
  return Object.keys(out).length ? out : undefined;
}

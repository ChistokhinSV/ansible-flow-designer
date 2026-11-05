// What a run's input box starts with (AFD-71): the value remembered for this flow, else the input's
// default, else, for the hosts of a skeleton run, localhost: check mode on this machine (or inside
// the container) is a safe first run, and Tutorial 1 starts with it.
import type { ContractField } from '../flow/types';

export function inputSuggestion(
  field: Pick<ContractField, 'type' | 'default'> | undefined,
  remembered: unknown,
  check: boolean,
): unknown {
  if (remembered !== undefined) return remembered;
  if (field?.default !== undefined) return field.default;
  return check && field?.type === 'host_list' ? ['localhost'] : undefined;
}

/** The prompt under a run input's box; AFD-95: its description first, when it has one. */
export function inputPrompt(
  type: string | undefined,
  secret: boolean,
  check: boolean,
  description?: string,
): string {
  if (description) return `${description} (${type ?? 'value'}${secret ? ', not remembered' : ''})`;
  if (type === 'host_list')
    return check
      ? 'Hosts or groups, comma-separated. localhost runs the skeleton on this machine (or inside the container).'
      : 'Hosts or groups, comma-separated';
  return `${type ?? 'value'}${secret ? ' (not remembered)' : ''}`;
}

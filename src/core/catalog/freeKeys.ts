// AFD-222: set_fact's doc names one required option, key_value, for the facts it sets; in a task
// the facts are the parameters' own keys. Configure shows them as Facts, and neither its checklist
// nor the catalog checks ask for key_value or call a fact an unknown parameter.

const SET_FACT = /^(ansible\.(builtin|legacy)\.)?set_fact$/;

/** Whether a module's parameters are free keys (set_fact's facts). */
export function takesFreeKeys(ref: string | undefined): boolean {
  return !!ref && SET_FACT.test(ref);
}

/** A module's documented options without the stand-in for its free keys. */
export function documentedOptions<T>(
  ref: string | undefined,
  options: Record<string, T> | undefined,
): Record<string, T> | undefined {
  if (!options || !takesFreeKeys(ref) || !('key_value' in options)) return options;
  const { key_value: _, ...rest } = options;
  return rest;
}

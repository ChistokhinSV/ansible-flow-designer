// A flow input's default as the inputs editor edits it (AFD-106, round 3: R6 and Y5): text in a
// box, read by the input's type. Before, a default could only be written in YAML by hand, so a run
// could go without a value the flow needed.
import { parse } from 'yaml';
import type { ContractType } from '../flow/types';

/** The default as the box shows it. */
export function defaultText(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (Array.isArray(value)) return value.map(String).join(', ');
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

/**
 * The box's text as the input's type has it: a whole number, true or false, a list (commas or one
 * per line), a YAML map; an empty box clears the default.
 */
export function defaultValue(
  type: ContractType,
  text: string,
): { value?: unknown; problem?: string } {
  const t = text.trim();
  if (!t) return {};
  switch (type) {
    case 'integer':
      return /^-?[0-9]+$/.test(t) ? { value: Number(t) } : { problem: 'A whole number' };
    case 'boolean': {
      const v = t.toLowerCase();
      if (['true', 'yes'].includes(v)) return { value: true };
      if (['false', 'no'].includes(v)) return { value: false };
      return { problem: 'true or false' };
    }
    case 'list':
    case 'host_list':
      return {
        value: t
          .split(/[,\n]/)
          .map((x) => x.trim())
          .filter(Boolean),
      };
    case 'dict': {
      try {
        const v = parse(t);
        if (v && typeof v === 'object' && !Array.isArray(v)) return { value: v };
      } catch {
        // Falls through to the problem.
      }
      return { problem: 'A map, like {site: fra1}' };
    }
    case 'any':
      try {
        return { value: parse(t) };
      } catch {
        return { value: t };
      }
    default:
      return { value: t };
  }
}

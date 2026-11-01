// AWX surveys from the flow inputs (AFD-59): Set Up AWX Template writes the template's survey, so
// whoever launches the flow in AWX is asked for what the flow needs. The survey we write carries a
// fingerprint in its description; one whose content no longer matches it was edited in AWX, and
// is replaced only after asking (product-owner decision).
import type { ContractField, FlowDocument } from '../flow/types';
import { SECRET } from '../import/secrets';

export interface AwxSurveyQuestion {
  question_name: string;
  question_description: string;
  required: boolean;
  type: 'text' | 'textarea' | 'password' | 'integer' | 'float' | 'multiplechoice' | 'multiselect';
  variable: string;
  /** Left out when empty: AWX checks a default against the question's type and choices. */
  default?: string | number;
  choices?: string;
  min?: number;
  max?: number;
}

export interface AwxSurveySpec {
  name: string;
  description: string;
  spec: AwxSurveyQuestion[];
}

const MARK = 'Written by Ansible Flow Designer from flow';

/** FNV-1a of the questions: tells a survey we wrote from one edited since. */
function fingerprint(spec: readonly AwxSurveyQuestion[]): string {
  const text = JSON.stringify(
    spec.map((q) => [q.variable, q.type, q.required, q.default, q.choices ?? '']),
  );
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/**
 * The question for an input, or none: AWX answers a survey with text (and numbers), so a boolean, a
 * list or a mapping would reach the flow as text (`'false'` is true in Jinja). Those stay extra
 * variables, which the template accepts at launch.
 */
function question(name: string, field: ContractField): AwxSurveyQuestion | undefined {
  const base = {
    question_name: name,
    required: !!field.required,
    variable: name,
  };
  const value = field.default;
  if (SECRET.test(name))
    return {
      ...base,
      type: 'password',
      question_description: 'Secret: not stored in the flow',
      min: 0,
      max: 1024,
    };
  switch (field.type) {
    case 'host_list':
      // The generated start play takes the text as it takes a list.
      return {
        ...base,
        type: 'text',
        question_description: `Hosts or groups, comma-separated${field.targets ? ' (the flow runs on them)' : ''}`,
        default: Array.isArray(value) ? value.join(',') : typeof value === 'string' ? value : '',
        min: 0,
        max: 4096,
      };
    case 'integer':
      return {
        ...base,
        type: 'integer',
        question_description: 'A whole number',
        default: typeof value === 'number' ? value : '',
      };
    case 'string':
      return {
        ...base,
        type: 'text',
        question_description: '',
        default: value === undefined ? '' : String(value),
        min: 0,
        max: 1024,
      };
    default:
      return undefined;
  }
}

const withoutEmpty = (q: AwxSurveyQuestion): AwxSurveyQuestion => {
  const { default: value, ...rest } = q;
  return value === '' || value === undefined ? rest : { ...rest, default: value };
};

/** The survey Set Up AWX Template writes: one question per flow input, in the flow's order. */
export function surveyFor(doc: FlowDocument): AwxSurveySpec {
  const spec = Object.entries(doc.flow.inputs ?? {}).flatMap(([name, f]) => {
    const q = question(name, f);
    return q ? [withoutEmpty(q)] : [];
  });
  return {
    name: doc.flow.name,
    description: `${MARK} ${doc.flow.key} · ${fingerprint(spec)}`,
    spec,
  };
}

/**
 * Launch inputs as the survey takes them: AWX checks survey answers by type, so a host list goes as
 * comma-separated text (the generated start play takes either); everything else as it is.
 */
export function launchVars(
  doc: FlowDocument,
  inputs: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...inputs };
  for (const [name, f] of Object.entries(doc.flow.inputs ?? {})) {
    const value = out[name];
    if (f?.type === 'host_list' && Array.isArray(value)) out[name] = value.join(',');
  }
  return out;
}

/**
 * What to do with the survey a template has: write ours where there is none or where it is ours
 * as we left it, keep it when it already says what we would write, and ask when someone changed
 * it in AWX (or wrote it by hand).
 */
export function surveyAction(
  current: Partial<AwxSurveySpec> | undefined,
  wanted: AwxSurveySpec,
): 'write' | 'same' | 'ask' {
  const spec = current?.spec ?? [];
  if (spec.length === 0) return 'write';
  const now = fingerprint(spec as AwxSurveyQuestion[]);
  if (current?.description === wanted.description && now === fingerprint(wanted.spec))
    return 'same';
  const ours = current?.description?.startsWith(MARK) && current.description.endsWith(` · ${now}`);
  return ours ? 'write' : 'ask';
}

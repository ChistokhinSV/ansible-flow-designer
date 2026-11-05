// AFD-59: the AWX survey Set Up AWX Template writes from the flow inputs, and when a survey in AWX
// is ours to replace.
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { launchVars, surveyAction, surveyFor } from '../../../src/core/awx/survey';
import type { FlowDocument } from '../../../src/core/flow/types';
import { readExample } from './helpers';

const doc = parse(readExample('edge-baseline.flow.yaml')) as FlowDocument;
const withInputs = (inputs: FlowDocument['flow']['inputs']): FlowDocument => ({
  ...doc,
  flow: { ...doc.flow, inputs },
});

describe('AWX survey from the flow inputs (AFD-59)', () => {
  it('a launch sends a host list as text, as the survey takes it', () => {
    expect(launchVars(doc, { devices: ['sw-01', 'sw-02'], site: 'lab' })).toEqual({
      devices: 'sw-01,sw-02',
      site: 'lab',
    });
  });

  it('asks for what AWX types faithfully, secrets as passwords; the rest stays extra vars', () => {
    const s = surveyFor(
      withInputs({
        devices: { type: 'host_list', required: true, targets: true },
        retries: { type: 'integer', default: 3 },
        dry_run: { type: 'boolean', default: false },
        banner: { type: 'string', required: true },
        vault_password: { type: 'string', required: true },
        extra: { type: 'dict' },
      }),
    );
    expect(s.name).toBe(doc.flow.name);
    expect(s.description).toMatch(
      /^Written by Ansible Flow Designer from flow edge-baseline · [0-9a-f]{8}$/,
    );
    // A boolean or a mapping would arrive as text ('false' is true in Jinja): not asked.
    expect(s.spec.map((q) => [q.variable, q.type, q.required, q.default])).toEqual([
      ['devices', 'text', true, undefined],
      ['retries', 'integer', false, 3],
      ['banner', 'text', true, undefined],
      ['vault_password', 'password', true, undefined],
    ]);
    expect(s.spec[0]?.question_description).toContain('comma-separated');
    expect(s.spec.every((q) => !('default' in q) || q.default !== '')).toBe(true);
  });

  it('writes where there is none or ours is as we left it; asks when it was changed in AWX', () => {
    const ours = surveyFor(doc);
    expect(surveyAction(undefined, ours)).toBe('write');
    expect(surveyAction({}, ours)).toBe('write');
    expect(surveyAction(ours, ours)).toBe('same');
    // The flow gained an input: our old survey, untouched, is replaced without asking.
    const more = surveyFor(withInputs({ ...doc.flow.inputs, owner_email: { type: 'string' } }));
    expect(surveyAction(ours, more)).toBe('write');
    // Someone changed a question in AWX, or wrote the survey by hand.
    const edited = {
      ...ours,
      spec: ours.spec.map((q, i) => (i === 0 ? { ...q, required: false } : q)),
    };
    expect(surveyAction(edited, more)).toBe('ask');
    expect(surveyAction({ name: 'Hand made', description: '', spec: ours.spec }, more)).toBe('ask');
  });
});

describe('input descriptions in the survey (AFD-95)', () => {
  it('lead the question; a survey written before is ours to update, not "edited"', () => {
    const plain = surveyFor({
      ...doc,
      flow: { ...doc.flow, inputs: { ticket: { type: 'string', required: true } } },
    });
    const described = surveyFor({
      ...doc,
      flow: {
        ...doc.flow,
        inputs: {
          ticket: { type: 'string', required: true, description: 'The change ticket' },
        },
      },
    });
    expect(described.spec[0]?.question_description).toBe('The change ticket');
    // AWX has the survey we wrote before: ours and unedited, so the description is written.
    expect(surveyAction(plain, described)).toBe('write');
    expect(surveyAction(described, described)).toBe('same');
  });
});

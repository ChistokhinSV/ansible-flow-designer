// AFD-73: the first-flow checklist ticks from the flow (a step, no open fail port) and from the
// user's progress (the playbook seen, a skeleton run).
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { planCommand } from '../../../src/core/flow/commands';
import { createIdFactory } from '../../../src/core/flow/ids';
import { modelOf } from '../../../src/core/flow/model';
import { openFailPorts } from '../../../src/core/flow/openPorts';
import { newFlowText } from '../../../src/core/flow/template';
import type { FlowDocument } from '../../../src/core/flow/types';
import { firstFlowItems, isFirstFlowSize } from '../../../src/core/view/firstFlow';

const ctx = { newId: createIdFactory() };
const fresh = newFlowText('NTP baseline', 'ntp-baseline', ctx.newId);
const doc = (text: string) => parse(text) as FlowDocument;
const ticks = (text: string, done: string[] = []) => {
  const d = doc(text);
  return firstFlowItems(d, openFailPorts(modelOf(d)).length, done)
    .filter((i) => i.done)
    .map((i) => i.id);
};

describe('first-flow checklist (AFD-73)', () => {
  const wire = doc(fresh).edges?.[0]?.id as string;
  const one = planCommand(
    fresh,
    { kind: 'addNode', type: 'task', title: 'Check NTP', insertOn: wire },
    ctx,
  );
  const step = one.created as string;

  it('a new flow has the empty-level card instead; a first step brings the checklist', () => {
    expect(isFirstFlowSize(doc(fresh))).toBe(false);
    expect(isFirstFlowSize(doc(one.text))).toBe(true);
    expect(ticks(fresh)).toEqual([]);
  });

  it('ticks the step, then the code seen, the failure handled and the skeleton run', () => {
    expect(ticks(one.text)).toEqual(['step']);
    expect(ticks(one.text, ['codeSeen'])).toEqual(['step', 'code']);
    const handled = planCommand(
      one.text,
      { kind: 'applyPattern', pattern: 'stop', from: { node: step, port: 'failed_hosts' } },
      ctx,
    ).text;
    expect(ticks(handled, ['codeSeen', 'skeletonRun'])).toEqual(['step', 'code', 'failure', 'run']);
  });

  it('a flow bigger than a first one has no checklist', () => {
    let text = one.text;
    for (let i = 0; i < 5; i++)
      text = planCommand(text, { kind: 'addNode', type: 'task', title: `Step ${i}` }, ctx).text;
    expect(isFirstFlowSize(doc(text))).toBe(false);
  });
});

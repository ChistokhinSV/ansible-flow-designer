// The task cards of a usability session (AFD-78), filled with a variant's names. A card says what
// to achieve, never which control to use, so the same card fits 0.50.0 and the wave 8 build. Round
// 3's cards (AFD-99) are in round3/cards.ts.

import type { Variant } from './variants';

export interface TaskCard {
  id: string;
  /** The part the task belongs to (rounds 1-2: 1 or 2; round 3: 1 to 4). */
  part: number;
  title: string;
  /** What to achieve, in the participant's words. */
  goal: string;
  /** Asked when the task wants a typed answer. */
  answer?: string;
  /** Minutes after which the runner suggests moving on. */
  softLimit: number;
  /** What the task probes (docs/ux/wave8-usability/tasks.md, docs/ux/wave9-usability/tasks.md). */
  probes: string;
  /** The kit changes a flow outside the designer when the task starts (round 2 T11, round 3 T16). */
  outsideEdit?: boolean;
  /** Shown before Start: what to prepare. The goal itself shows only on Start. */
  before?: string;
}

export function taskCards(v: Variant): TaskCard[] {
  const h = v.health;
  const r = v.rollout;
  const u = v.upgrade;
  const p = v.pipeline;
  const inputs = Object.entries(r.inputs)
    .map(([, f]) => `${f.description.toLowerCase()}: ${f.value}`)
    .join('; ');
  const title = (sub: string, key: string) =>
    u.subflows.find((s) => s.key === sub)?.steps.find((s) => s.key === key)?.title ?? key;
  const sub = (key: string) =>
    u.subflows.find((s) => s.steps.some((x) => x.key === key))?.key ?? '';
  return [
    {
      id: 'T1',
      part: 1,
      title: 'Your first flow',
      goal: `Create a new flow named "${v.first.name}". It first checks that each device answers, then does the second job. Give the two steps the titles "${v.first.steps[0]}" and "${v.first.steps[1]}". You do not need to choose modules for them.`,
      softLimit: 6,
      probes: 'core',
    },
    {
      id: 'T2',
      part: 1,
      title: 'Make a step do something',
      goal: `In the flow "${v.baseline.name}", the step "${v.baseline.draft.title}" does nothing yet. Make it use the module ${v.baseline.bind.module} so that it writes the line "${v.baseline.bind.params.line}" into the file ${v.baseline.bind.params.path}. Save the flow.`,
      softLimit: 6,
      probes: 'C binding panel',
    },
    {
      id: 'T3',
      part: 1,
      title: 'Handle a failure',
      goal: `In "${v.baseline.name}", hosts that fail "${v.baseline.check.title}" have nowhere to go yet. Make sure such hosts do not continue and end in "Stopped". Save the flow.`,
      softLimit: 5,
      probes: 'core',
    },
    {
      id: 'T4',
      part: 1,
      title: 'Try it without changing anything',
      goal: `Run "${h.name}" as a check, so nothing is changed, on all lab ${v.devicesWord} (the inventory group lab). Some ${v.devicesWord} fail.`,
      answer: `Which step failed, and for which ${v.deviceWord}? Name every pair you find.`,
      softLimit: 8,
      probes: 'A live runs',
    },
    {
      id: 'T5',
      part: 1,
      title: 'A real run with inputs',
      goal: `Run "${r.name}" for real on the lab group, with ${inputs}. The lab hosts are fictional and use the local connection: nothing reaches a device.`,
      softLimit: 8,
      probes: 'B launch dialog, A live runs',
    },
    {
      id: 'T6',
      part: 2,
      title: 'Find things in a large flow',
      goal: `Open "${u.name}". Look on every level of it.`,
      answer:
        'Which steps are not implemented yet (no module, role or playbook)? Which steps are approvals? Name each one.',
      softLimit: 6,
      probes: 'D find filters',
    },
    {
      id: 'T7',
      part: 2,
      title: 'Know your repository',
      goal: 'Get an overview of the flows in this repository, opening as few of them as you can.',
      answer:
        "Which flow has an error that stops it from generating code? Which flow's generated playbook was changed by hand?",
      softLimit: 5,
      probes: 'D flows view',
    },
    {
      id: 'T8',
      part: 2,
      title: 'Scenario tests',
      goal: `"${h.name}" has scenario tests. Run them. One of them fails.`,
      answer: `Which ${v.deviceWord} ended where, where was it expected to end, and why?`,
      softLimit: 6,
      probes: 'E scenarios on the canvas',
    },
    {
      id: 'T9',
      part: 2,
      title: 'Privileges',
      goal: `In "${u.name}", use the Access lens: it shows who acts with which privileges. Two steps raise privileges unlike their neighbours. "${title(sub(u.needsRoot), u.needsRoot)}" really needs root: keep it and record why. "${title(sub(u.noRoot), u.noRoot)}" does not need root: fix it. Save the flow.`,
      softLimit: 6,
      probes: 'F lens findings in Details',
    },
    {
      id: 'T10',
      part: 2,
      title: 'Tidy three steps',
      goal: `In "${p.name}", the steps "${p.steps[1]?.title}", "${p.steps[2]?.title}" and "${p.steps[3]?.title}" sit unevenly. Line them up in a straight column, evenly spaced, without moving any other step. Save the flow.`,
      softLimit: 5,
      probes: 'G align and distribute',
    },
    {
      id: 'T11',
      part: 2,
      title: "Spot an agent's change",
      goal: `Save everything and keep "${u.name}" open in the designer. When you press Start, the kit plays a coding agent that edits this flow on disk, as an AI assistant can. Find out what it changed.`,
      answer: 'What did the agent change?',
      softLimit: 6,
      probes: 'H outside edits',
      outsideEdit: true,
    },
  ];
}

/** System Usability Scale (Brooke, 1996): odd items positive, even items negative. */
export const SUS = [
  'I think that I would like to use this system frequently.',
  'I found the system unnecessarily complex.',
  'I thought the system was easy to use.',
  'I think that I would need the support of a technical person to be able to use this system.',
  'I found the various functions in this system were well integrated.',
  'I thought there was too much inconsistency in this system.',
  'I would imagine that most people would learn to use this system very quickly.',
  'I found the system very cumbersome to use.',
  'I felt very confident using the system.',
  'I needed to learn a lot of things before I could get going with this system.',
];

/** SUS score 0-100 from ten answers 1-5; undefined while an answer is missing. */
export function susScore(answers: (number | undefined)[]): number | undefined {
  if (answers.length !== 10 || answers.some((a) => a === undefined)) return undefined;
  const sum = answers.reduce<number>(
    (s, a, i) => s + (i % 2 === 0 ? (a as number) - 1 : 5 - (a as number)),
    0,
  );
  return sum * 2.5;
}

// Round 4's task cards (AFD-109, docs/ux/wave10-usability/tasks.md). As in rounds 1-3, a card says
// what to achieve, never which control to use, and its goal shows on Start. Each task has the shape
// of a round 3 task (named in `probes`), so times compare by direction.
import type { Part } from '../study';
import type { TaskCard } from '../tasks';
import { D } from './data';

const q = (s: string) => `"${s}"`;

export const PARTS: Record<number, Part> = {
  1: {
    title: "the workspace and a step's settings",
    note: 'VS Code is open on the lab workspace.',
  },
  2: {
    title: 'data in and out',
    note: 'A short break first if you like: the clock only runs inside a task.',
  },
  3: {
    title: 'runs, tests and the team',
    note: 'A short break first if you like. The last four tasks.',
  },
};

export const INTRO =
  'in three parts, with a short break between them if you like. It takes about 45 minutes.';

export function roundFourCards(): TaskCard[] {
  const p = D.pool;
  const h = D.health;
  const u = D.upgrade;
  const step = (sub: string, key: string) =>
    u.subflows.find((s) => s.key === sub)?.steps.find((s) => s.key === key)?.title ?? key;
  const list = (xs: string[]) => `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}`;
  return [
    {
      id: 'D1',
      part: 1,
      title: 'Know your workspace',
      goal: "Get an overview of this workspace's flows, opening as few of them as you can.",
      answer:
        "Which flow has an error that stops it from generating code? Which flow's generated playbook was changed by hand?",
      softLimit: 3,
      probes: 'control (round 3 T13): Problems for every flow, the playbook warning',
    },
    {
      id: 'D2',
      part: 1,
      title: 'Wait until it has drained',
      goal: `In ${q(p.name)}, ${q(p.wait.title)} checks only once. Make it keep checking, up to ${p.retries} times, ${p.delay} seconds apart, until its output says ${p.until}. Save the flow.`,
      answer: 'How long can one of those checks take at most?',
      softLimit: 6,
      probes:
        'round 3 T6 (R1, R2): Timing open on a module step, the Timing sentence, Until suggestions',
    },
    {
      id: 'D3',
      part: 1,
      title: 'Keep a secret out of the logs',
      goal: `In ${q(p.name)}, what ${q(p.readKey.title)} reads must never show in logs or run output. Save the flow.`,
      softLimit: 3,
      probes: 'round 3 T8 (R3): the Task keywords fold and its chips; Z2 fold state',
    },
    {
      id: 'D4',
      part: 1,
      title: 'Once per member',
      goal: `In ${q(p.name)}, ${q(p.disable.title)} disables the member ${p.placeholder}, which does not exist. Make it run once for each of the members ${list(p.members)}, with the member's name in its command in place of ${p.placeholder}. Save the flow.`,
      softLimit: 6,
      probes: 'round 3 T9 (R3, R4): the loop chip, the YAML box, a parameter reading item',
    },
    {
      id: 'D5',
      part: 2,
      title: 'Pass a result on',
      goal: `In ${q(p.name)}, ${q(p.report.title)} always prints "unknown". Make it print what ${q(p.readState.title)} printed (its standard output). Save the flow.`,
      softLimit: 6,
      probes: 'round 3 T4 (R7, Z1): the @ result, its fields, input-unfed',
    },
    {
      id: 'D6',
      part: 2,
      title: 'A value with a default',
      goal: `In ${q(p.name)}, whoever runs the flow should be able to say how many seconds to wait for the pool to drain: ${p.drainWait} unless they give another number. Explain the value, so they know what it is for. Save the flow.`,
      softLimit: 6,
      probes: 'round 3 T5 (R6): the Default box, required, the description',
    },
    {
      id: 'D7',
      part: 3,
      title: 'Check one data centre',
      goal: `Run ${q(D.dns.name)} as a check, so nothing is changed, on the ${D.devicesWord} of the data centre ${D.dns.serial.fails} belongs to, and only those. Some of them fail.`,
      answer: `Which step failed, and for which ${D.deviceWord}? Name every pair you find.`,
      softLimit: 6,
      probes: "control (round 3 T10): a group's hosts, Run Results, Output",
    },
    {
      id: 'D8',
      part: 3,
      title: 'Scenario tests',
      goal: `${q(h.name)} has scenario tests. Run them. One of them fails.`,
      answer: `Which ${D.deviceWord} ended where, where was it expected to end, and why?`,
      softLimit: 5,
      probes: 'round 3 T12 (R8): planted failures in words',
    },
    {
      id: 'D9',
      part: 3,
      title: 'Privileges',
      goal: `In ${q(u.name)}, the Access lens flags two steps that run as root unlike their neighbours. ${q(step('upgrade', u.needsRoot))} really needs root: keep it and record why. ${q(step('verify', u.noRoot))} does not need root: fix it. Save the flow.`,
      softLimit: 5,
      probes: 'round 3 T15 (R10): Accept with Reason first, the Privilege note',
    },
    {
      id: 'D10',
      part: 3,
      title: "A colleague's change",
      before:
        'Before Start: save all files in VS Code (File > Save All) and close the designer tabs. Start makes the kit commit your work so far and bring in a change to a flow.',
      goal: `When you pressed Start, the kit committed your work so far, then brought in a colleague's change to ${q(u.name)}, as a Git pull would. Find out what the colleague changed.`,
      answer: 'What did the colleague change? Say it step by step.',
      softLimit: 5,
      probes: 'round 3 T16 (R9): the change list, the Changes lens since last open',
      outsideEdit: true,
    },
  ];
}

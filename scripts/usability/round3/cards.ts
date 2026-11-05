// Round 3's task cards (AFD-99, docs/ux/wave9-usability/tasks.md). As in rounds 1 and 2, a card
// says what to achieve, never which control to use, and its goal shows on Start.
import type { Part } from '../study';
import type { TaskCard } from '../tasks';
import { C } from './data';

const q = (s: string) => `"${s}"`;

export const PARTS: Record<number, Part> = {
  1: { title: 'change a flow', note: 'VS Code is open on the lab workspace.' },
  2: {
    title: 'settings and inputs',
    note: 'A short break first if you like: the clock only runs inside a task.',
  },
  3: {
    title: 'run and test',
    note: 'Halfway: take your break now. The clock only runs inside a task.',
  },
  4: {
    title: 'review the workspace',
    note: 'A short break first if you like. The last four tasks.',
  },
};

export const INTRO =
  'in four parts, with a longer break after part 2. It takes about an hour and a half.';

export function roundThreeCards(): TaskCard[] {
  const b = C.baseline;
  const d = C.deploy;
  const k = C.backup;
  const h = C.health;
  const u = C.upgrade;
  const step = (sub: string, key: string) =>
    u.subflows.find((s) => s.key === sub)?.steps.find((s) => s.key === key)?.title ?? key;
  const ticket = C.rollout.inputs;
  return [
    {
      id: 'T1',
      part: 1,
      title: 'Add a check in the middle',
      goal: `In ${q(b.name)}, add a step ${q(b.insert)} between ${q(b.check.title)} and ${q(b.banner.title)}. Firewalls that fail it must not continue: they end the flow as stopped. Save the flow.`,
      softLimit: 4,
      probes: 'W1 palette after the selected step, W5 Stop Flow, S1 port hover',
    },
    {
      id: 'T2',
      part: 1,
      title: 'Write the login banner',
      goal: `In ${q(b.name)}, make ${q(b.banner.title)} use ${b.bind.module} to write the text ${q(b.bind.params.content)} into ${b.bind.params.dest}, owned by ${b.bind.params.owner}, with file mode ${b.bind.params.mode}. Save the flow.`,
      softLimit: 6,
      probes: 'C Configure, parameter search',
    },
    {
      id: 'T3',
      part: 1,
      title: "Change a step's parameters",
      goal: `In ${q(d.name)}, ${q(d.push.title)} leaves the rule file readable by everyone and keeps a backup copy of the old one. Make the file readable by its owner only (mode ${d.mode}) and stop keeping backups. Leave its other parameters as they are. Save the flow.`,
      softLimit: 4,
      probes: 'C changing and clearing a value',
    },
    {
      id: 'T4',
      part: 1,
      title: 'Pass a result on',
      goal: `In ${q(d.name)}, ${q(d.report.title)} always prints "unknown". Make it print the version that ${q(d.read.title)} read (its standard output). Save the flow.`,
      softLimit: 6,
      probes: 'data between steps: outputs, the @ picker',
    },
    {
      id: 'T5',
      part: 2,
      title: 'A value given at run time',
      goal: `In ${q(k.name)}, ${q(k.upload.title)} always uploads to ${k.server}. Make the archive server a value that whoever runs the flow must give, explained as ${q(k.description)}. Save the flow.`,
      softLimit: 7,
      probes: 'W9 input descriptions, the inputs editor, @ picker',
    },
    {
      id: 'T6',
      part: 2,
      title: 'Wait until it is ready',
      goal: `In ${q(d.name)}, ${q(d.wait.title)} checks only once. Make it keep checking, up to ${d.retries} times, ${d.delay} seconds apart, until its output says ${d.until}. Save the flow.`,
      softLimit: 5,
      probes: 'Timing settings; Until names the result',
    },
    {
      id: 'T7',
      part: 2,
      title: 'One at a time',
      goal: `In ${q(u.name)}, the subflow ${q('Upgrade the software')} upgrades every ${C.deviceWord} at once. Make it upgrade one ${C.deviceWord} at a time, each through all its steps before the next one starts. Save the flow.`,
      softLimit: 4,
      probes: 'rolling subflows',
    },
    {
      id: 'T8',
      part: 2,
      title: 'Handle a secret',
      goal: `In ${q(k.name)}, ${q(k.readKey.title)} must run as the user ${k.user}, not as root, and what it reads must never show in logs or run output. Save the flow.`,
      softLimit: 5,
      probes: 'Privilege settings, task keywords',
    },
    {
      id: 'T9',
      part: 2,
      title: 'Once per zone',
      goal: `In ${q(k.name)}, ${q(k.exportZones.title)} exports the zone ZONE, which does not exist. Make it run once for each of the zones ${k.zones.slice(0, -1).join(', ')} and ${k.zones.at(-1)}, with the zone's name in its command in place of ZONE. Save the flow.`,
      softLimit: 6,
      probes: 'task keywords, a parameter reading a loop variable',
    },
    {
      id: 'T10',
      part: 3,
      title: 'Check one site',
      goal: `Run ${q(h.name)} as a check, so nothing is changed, on the ${C.devicesWord} of the site ${h.first.fails} belongs to, and only those. Some of them fail.`,
      answer: `Which step failed, and for which ${C.deviceWord}? Name every pair you find.`,
      softLimit: 8,
      probes: "S2 a group's hosts, X5 no host list given, S3 Run Results, S4 Output",
    },
    {
      id: 'T11',
      part: 3,
      title: 'A real run from a ticket',
      goal: `Change ticket ${ticket.chg?.value} approves rule set ${ticket.rs_tag?.value} for the window ${ticket.mw?.value} UTC. Run ${q(C.rollout.name)} for real on all lab ${C.devicesWord} with what the ticket says. The lab hosts are fictional and use the local connection: nothing reaches a device.`,
      softLimit: 6,
      probes: 'W9 input descriptions in the dialog, S6 Run in view',
    },
    {
      id: 'T12',
      part: 3,
      title: 'Scenario tests',
      goal: `${q(h.name)} has scenario tests. Run them. One of them fails.`,
      answer: `Which ${C.deviceWord} ended where, where was it expected to end, and why?`,
      softLimit: 5,
      probes: 'S9 scenario results in words',
    },
    {
      id: 'T13',
      part: 4,
      title: 'Know your workspace',
      goal: "Get an overview of this workspace's flows, opening as few of them as you can.",
      answer:
        "Which flow has an error that stops it from generating code? Which flow's generated playbook was changed by hand?",
      softLimit: 5,
      probes: 'S8 Problems for every flow, the playbook warning, the flow panel line',
    },
    {
      id: 'T14',
      part: 4,
      title: 'Keep a fix made by hand',
      goal: `Someone fixed the generated playbook of ${q(C.rotation.name)} by hand: it now keeps archives for 30 days instead of 7. Keep that fix for good: make the flow do the same, so that generating its code again keeps 30 days and the playbook no longer counts as changed by hand.`,
      softLimit: 6,
      probes: "the playbook warning's Open the Flow, changing a value, overwriting code",
    },
    {
      id: 'T15',
      part: 4,
      title: 'Privileges',
      goal: `In ${q(u.name)}, use the Access lens: it shows who acts with which privileges. Two steps raise privileges unlike their neighbours. ${q(step('upgrade', u.needsRoot))} really needs root: keep it and record why. ${q(step('verify', u.noRoot))} does not need root: fix it. Save the flow.`,
      softLimit: 5,
      probes: 'S10 lens rows that stay put, S11 lighting, X4 the fold',
    },
    {
      id: 'T16',
      part: 4,
      title: "A colleague's change",
      before:
        'Before Start: save all files in VS Code (File > Save All) and close the designer tabs. Start makes the kit commit your work so far and bring in a change to a flow.',
      goal: `When you pressed Start, the kit committed your work so far, then brought in a colleague's change to ${q(u.name)}, as a Git pull would. Find out what the colleague changed.`,
      answer: 'What did the colleague change?',
      softLimit: 5,
      probes: 'S12 marks for changes made while the flow was closed, Git included',
      outsideEdit: true,
    },
  ];
}

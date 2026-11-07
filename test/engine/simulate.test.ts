// The scenario simulator held to Ansible (AFD-114, ADR-0032): each case is a flow and a scenario,
// staged as a scenario run stages it (stageScenario) and run by ansible-playbook in each image; the
// summary its routing events give must equal the simulator's. Cases: the engine fixtures and
// examples, the transforms the engine tests make (extracted, rolled, privileged), and seeded random
// flows with random scenarios (test/shared/flowFuzz.ts). Opt-in (Docker): `just test-engine`.
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { GenerateResult } from '../../src/core/engine/types';
import { summarizeRun } from '../../src/core/run/events';
import { simulateRun } from '../../src/core/scenario/simulate';
import { stageScenario } from '../../src/node/scenario/runner';
import { normal, simulateCases } from '../shared/simulateCases';

const IMAGES = (
  process.env.AFD_ENGINE_IMAGES ?? 'ps-probe-env:2.19,ps-probe-env:2.20,ps-probe-env:2.21'
).split(',');
const REPO = resolve(__dirname, '../..');
const CALLBACKS = join(REPO, 'probe/callback_plugins');
const FUZZ = Number(process.env.AFD_SIM_FUZZ ?? 60);
/** Plays run side by side in the container. */
const PARALLEL = 4;

const CASES = simulateCases(FUZZ);

describe.each(IMAGES)('the simulator matches Ansible on %s', (image) => {
  let dir = '';
  const builds: (GenerateResult | undefined)[] = [];

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'afd-simulate-'));
    chmodSync(dir, 0o777);
    for (const [i, c] of CASES.entries()) {
      const cdir = join(dir, `c${i}`);
      mkdirSync(cdir);
      chmodSync(cdir, 0o777);
      const build = stageScenario(
        c.doc,
        { name: c.name, expect: {}, ...c.s },
        cdir,
        'case.flow.yaml',
      );
      builds.push(build);
      if (!build) continue;
      writeFileSync(
        join(cdir, 'run.sh'),
        `cd /work/c${i} && AFD_EVENTS=/work/c${i}/events.jsonl ansible-playbook -i inventory.ini -e @vars.json ${build.files[0]?.name} > out.txt 2>&1; echo $? > rc\n`,
      );
    }
    writeFileSync(
      join(dir, 'run-all.sh'),
      [
        'n=0',
        'for d in /work/c*; do',
        '  [ -f "$d/run.sh" ] || continue',
        '  sh "$d/run.sh" &',
        '  n=$((n + 1))',
        `  [ $((n % ${PARALLEL})) -eq 0 ] && wait`,
        'done',
        'wait',
        '',
      ].join('\n'),
    );
    execFileSync(
      'docker',
      [
        'run',
        '--rm',
        '-v',
        `${dir}:/work`,
        '-v',
        `${CALLBACKS}:/afd/callbacks:ro`,
        '-e',
        'ANSIBLE_CALLBACK_PLUGINS=/afd/callbacks',
        '-e',
        'ANSIBLE_CALLBACKS_ENABLED=afd_events',
        '-e',
        'ANSIBLE_HOST_PATTERN_MISMATCH=ignore',
        '-e',
        'ANSIBLE_HOST_KEY_CHECKING=False',
        '-e',
        'ANSIBLE_LOCALHOST_WARNING=False',
        '-e',
        'ANSIBLE_DEPRECATION_WARNINGS=False',
        image,
        'sh',
        '/work/run-all.sh',
      ],
      { stdio: 'pipe', timeout: 1_500_000 },
    );
  }, 1_560_000);

  afterAll(() => {
    if (dir && !process.env.AFD_KEEP) rmSync(dir, { recursive: true, force: true });
  });

  CASES.forEach((c, i) => {
    it(c.name, () => {
      const build = builds[i];
      expect(build, 'the flow generates').toBeDefined();
      if (!build) return;
      const cdir = join(dir, `c${i}`);
      const events = join(cdir, 'events.jsonl');
      const out = () => readFileSync(join(cdir, 'out.txt'), 'utf8').slice(-3000);
      expect(existsSync(events), out()).toBe(true);
      const real = summarizeRun(readFileSync(events, 'utf8'), build.routes);
      const sim = simulateRun(c.doc, c.s);
      // Best effort where the simulator says so; the unit tier keeps those few (simulateFuzz).
      if (sim.needsAnsible.length) return;
      expect(normal(sim.summary), `${c.name}\n${out()}`).toEqual(normal(real));
    });
  });
});

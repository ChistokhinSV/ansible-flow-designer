// Scenario tests for real (AFD-58): the runner the designer and the CI command line share runs the
// routing-levels scenarios in each Ansible image, and a wrong expectation is named. Opt-in (Docker):
// `just test-engine`.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import type { FlowDocument } from '../../src/core/flow/types';
import { parseScenarios } from '../../src/core/scenario/scenarios';
import { runScenarios } from '../../src/node/scenario/runner';

const IMAGES = (
  process.env.AFD_ENGINE_IMAGES ?? 'ps-probe-env:2.19,ps-probe-env:2.20,ps-probe-env:2.21'
).split(',');
const REPO = resolve(__dirname, '../..');
const FLOW = join(REPO, 'test/fixtures/engine/routing-levels.flow.yaml');

describe.each(IMAGES)('scenarios on %s', (image) => {
  it('the routing-levels scenarios pass; a host ending elsewhere is named', async () => {
    const doc = parse(readFileSync(FLOW, 'utf8')) as FlowDocument;
    const file = parseScenarios(
      readFileSync(join(REPO, 'test/fixtures/engine/routing-levels.scenarios.yaml'), 'utf8'),
    ).file;
    if (!file) throw new Error('fixture');
    file.scenarios.push({
      name: 'wrong on purpose',
      inputs: { devices: ['h01'] },
      force: { gate: { failed: ['h01'] } },
      expect: { h01: 'done' },
    });
    const work = mkdtempSync(join(tmpdir(), 'afd-scenarios-'));
    try {
      const results = await runScenarios({
        env: {
          kind: 'container',
          engine: 'docker',
          image,
          options: [],
          mounts: [],
          source: 'afd',
          label: image,
        },
        root: REPO,
        probeDir: join(REPO, 'probe'),
        flowFile: FLOW,
        doc,
        file,
        workDir: work,
      });
      expect(results.map((r) => [r.name, r.passed, r.error])).toEqual([
        ['every host goes through', true, undefined],
        ['hosts as comma-separated text, as an AWX survey answers', true, undefined],
        ['a failed stage is handled, a failed gate stops the host there', true, undefined],
        ['wrong on purpose', false, undefined],
      ]);
      expect(results[3]?.hosts).toEqual([
        { host: 'h01', expected: 'done', actual: 'gate.failed_hosts' },
      ]);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }, 600_000);

  // AFD-118: the scenarios the samples ship pass in Ansible too, not only in the simulation.
  it.each(['hello', 'edge-baseline'])(
    'the scenarios of the %s sample pass',
    async (key) => {
      const flowFile = join(REPO, 'samples', `${key}.flow.yaml`);
      const doc = parse(readFileSync(flowFile, 'utf8')) as FlowDocument;
      const file = parseScenarios(
        readFileSync(join(REPO, 'samples', `${key}.scenarios.yaml`), 'utf8'),
      ).file;
      if (!file) throw new Error('sample scenarios');
      const work = mkdtempSync(join(tmpdir(), 'afd-scenarios-'));
      try {
        const results = await runScenarios({
          env: {
            kind: 'container',
            engine: 'docker',
            image,
            options: [],
            mounts: [],
            source: 'afd',
            label: image,
          },
          root: REPO,
          probeDir: join(REPO, 'probe'),
          flowFile,
          doc,
          file,
          workDir: work,
        });
        expect(results.map((r) => [r.name, r.passed, r.error])).toEqual(
          file.scenarios.map((s) => [s.name, true, undefined]),
        );
      } finally {
        rmSync(work, { recursive: true, force: true });
      }
    },
    600_000,
  );
});

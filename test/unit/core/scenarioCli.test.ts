// AFD-114: the scenario command line: its options, --check and --simulate, and a simulated scenario
// the simulator cannot model reported as skipped, not judged.
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  loadScenarioFlows,
  parseCliArgs,
  problemLines,
  simulateFlow,
} from '../../../src/node/scenario/cli';
import { describeResults, failedCount, junitXml } from '../../../src/node/scenario/runner';

const FIX = join(__dirname, '../../fixtures/engine');

describe('scenario command line (AFD-114)', () => {
  it('reads its options and names the wrong ones', () => {
    expect(
      parseCliArgs([
        '--simulate',
        '--scenario',
        'a',
        '--scenario',
        'b',
        '--junit',
        'r.xml',
        'flows',
      ]),
    ).toEqual({
      targets: ['flows'],
      junit: 'r.xml',
      only: ['a', 'b'],
      keep: false,
      verbose: false,
      simulate: true,
      check: false,
      help: false,
    });
    expect(parseCliArgs(['--image', 'ee:1', '--engine', 'podman', 'x']).engine).toBe('podman');
    expect(parseCliArgs(['--engine', 'lxc', 'x']).error).toBe(
      '--engine takes docker or podman, not lxc',
    );
    expect(parseCliArgs(['--image']).error).toBe('--image needs a value');
    expect(parseCliArgs(['--simulat', 'x']).error).toBe('Unknown option --simulat');
    expect(parseCliArgs(['--check', '--simulate', 'x']).error).toBe(
      'Give --simulate or --check, not both',
    );
  });

  it('finds the flows with scenarios and simulates them', () => {
    const flows = loadScenarioFlows([FIX]);
    expect(flows.map((f) => f.doc.flow.key)).toEqual(['routing-levels']);
    const [levels] = flows;
    if (!levels) throw new Error('fixture');
    expect(problemLines(levels)).toEqual([]);
    const results = simulateFlow(levels, ['every host goes through']);
    expect(describeResults(results, levels.doc)).toEqual([
      'PASS every host goes through (simulated)',
    ]);
  });

  it('prints errors as FAIL and warnings as WARN', () => {
    const dir = mkdtempSync(join(tmpdir(), 'afd-cli-'));
    try {
      copyFileSync(join(FIX, 'routing-levels.flow.yaml'), join(dir, 'routing-levels.flow.yaml'));
      writeFileSync(
        join(dir, 'routing-levels.scenarios.yaml'),
        [
          'scenarios:',
          '  - name: two hosts, one checked',
          '    inputs: { devices: [h01, h02] }',
          '    force: { nowhere: { failed: [h01] } }',
          '    expect: { h01: done }',
        ].join('\n'),
      );
      const [f] = loadScenarioFlows([dir]);
      if (!f) throw new Error('no flow');
      expect(problemLines(f).map((l) => l.replace(dir, '<dir>'))).toEqual([
        `FAIL ${join('<dir>', 'routing-levels.scenarios.yaml')} [two hosts, one checked]: No step nowhere: use a key, or sub/step inside a subflow`,
        `WARN ${join('<dir>', 'routing-levels.scenarios.yaml')} [two hosts, one checked]: h02 runs but has no expectation, so where it ends is not checked`,
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('skips a simulated scenario the simulator cannot model', () => {
    const [levels] = loadScenarioFlows([FIX]);
    if (!levels?.file) throw new Error('fixture');
    levels.file.scenarios = [
      { name: 'a pattern', inputs: { devices: ['web*'] }, expect: { 'web*': 'done' } },
    ];
    const results = simulateFlow(levels);
    expect(failedCount(results)).toBe(0);
    expect(describeResults(results)).toEqual([
      'SKIP a pattern: the simulator does not model this; verify it with a run',
      '  The hosts to run on include a pattern; the simulator reads host names',
    ]);
    const xml = junitXml('routing-levels', results);
    expect(xml).toContain('tests="1" failures="0" skipped="1"');
    expect(xml).toContain(
      '<skipped message="Verify with a run: The hosts to run on include a pattern; the simulator reads host names"/>',
    );
  });
});

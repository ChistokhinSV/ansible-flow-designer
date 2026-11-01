// AFD-58: scenario files are checked against their flow, turn into the extra vars and inventory a
// run needs, and a run's routing says where each host ended.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { optionA } from '../../../src/core/engine/optionA';
import type { FlowDocument } from '../../../src/core/flow/types';
import type { RunSummary } from '../../../src/core/run/events';
import {
  checkScenarios,
  hostEnds,
  judge,
  parseScenarios,
  type Scenario,
  scenarioInventory,
  scenarioTemplate,
  scenarioVars,
} from '../../../src/core/scenario/scenarios';
import { readExample } from './helpers';

const FIX = join(__dirname, '../../fixtures/engine');
const LEVELS = parse(readFileSync(join(FIX, 'routing-levels.flow.yaml'), 'utf8')) as FlowDocument;
const FILE = parseScenarios(readFileSync(join(FIX, 'routing-levels.scenarios.yaml'), 'utf8'))
  .file as NonNullable<ReturnType<typeof parseScenarios>['file']>;
const id = (key: string) => LEVELS.nodes.find((n) => n.key === key)?.id as string;
const messages = (s: Scenario) => checkScenarios(LEVELS, { scenarios: [s] }).map((p) => p.message);

describe('scenario files (AFD-58)', () => {
  it('the fixture fits its flow; mistakes are named', () => {
    expect(checkScenarios(LEVELS, FILE)).toEqual([]);
    const base = { name: 'x', inputs: { devices: ['h01'] }, expect: { h01: 'done' } };
    expect(messages({ ...base, force: { nowhere: { failed: ['h01'] } } })).toEqual([
      'No step nowhere: use a key, or sub/step inside a subflow',
    ]);
    expect(messages({ ...base, force: { stage: { failed: ['h01'] } } })[0]).toContain(
      'force its steps (stage/<step>)',
    );
    expect(messages({ ...base, force: { gate: { unreachable: ['h01'] } } })).toEqual([
      'gate has no unreachable port: enable it, or force failed',
    ]);
    expect(messages({ ...base, force: { gate: { failed: ['h09'] } } })).toEqual([
      'h09 is not a host of this scenario',
    ]);
    expect(messages({ ...base, expect: { h01: 'nowhere', h02: 'done' } })).toEqual([
      "nowhere is neither an end node nor a step's output port (<step>.<port>)",
      'h02 is not in inputs.devices',
    ]);
    expect(messages({ ...base, inputs: {} })).toContain(
      'Set inputs.devices to the hosts to run on',
    );
  });

  it('turns into extra vars and a local-connection inventory', () => {
    const s = FILE.scenarios[1] as Scenario;
    expect(scenarioVars(s)).toEqual({
      devices: ['h01', 'h02', 'h03', 'h04', 'h05'],
      afd_simulate: { 'stage/prepare': { failed: ['h02'] }, gate: { failed: ['h03'] } },
    });
    const ini = scenarioInventory(LEVELS, { ...s, groups: { lb: ['lb-01'] } });
    expect(ini).toContain('h01 ansible_connection=local');
    expect(ini).toContain('[lb]\nlb-01 ansible_connection=local');
  });

  it('a run summary says where each host ended; the verdict compares', () => {
    const summary: RunSummary = {
      hosts: ['h01', 'h02', 'h03', 'h04'],
      nodes: {
        [id('stage')]: { ok_hosts: ['h01', 'h03'], failed_hosts: ['h02'] },
        [id('handle')]: { ok_hosts: ['h02'] },
        [id('gate')]: { ok_hosts: ['h01'], failed_hosts: ['h03'] },
      },
      outcome: {},
      failures: [],
      unreachable: [],
      stoppedEarly: false,
    };
    expect(hostEnds(LEVELS, summary)).toEqual({
      h01: 'done',
      h02: 'failed',
      h03: 'gate.failed_hosts',
      h04: 'stopped',
    });
    const s: Scenario = {
      name: 'x',
      inputs: { devices: ['h01', 'h03'] },
      expect: { h01: 'done', h03: 'done' },
    };
    expect(judge(LEVELS, s, summary)).toMatchObject({
      passed: false,
      hosts: [
        { host: 'h01', expected: 'done', actual: 'done' },
        { host: 'h03', expected: 'done', actual: 'gate.failed_hosts' },
      ],
    });
    expect(judge(LEVELS, s, undefined, 'docker: not found')).toMatchObject({
      passed: false,
      error: 'docker: not found',
    });
  });

  it('the starter file fits the flow it is written for', () => {
    for (const name of ['edge-baseline.flow.yaml', 'os-upgrade.flow.yaml']) {
      const doc = parse(readExample(name)) as FlowDocument;
      const file = parseScenarios(scenarioTemplate(doc)).file;
      expect(file && checkScenarios(doc, file), name).toEqual([]);
    }
  });

  it('the scenario build runs every step as its stub; decisions take true unless forced', () => {
    const os = parse(readExample('os-upgrade.flow.yaml')) as FlowDocument;
    const r = optionA.generate(os, { source: 'x', simulate: true, stubAll: true });
    const text = r.files.map((f) => f.text).join('\n');
    expect(text).toContain('# SCENARIO build');
    expect(text).not.toContain('cisco.ios.ios_config');
    expect(text).not.toContain('include_role');
    expect(text).toContain('takes true unless afd_simulate sends a host to false');
  });
});

// AFD-116: scenarios authored on the canvas: the chip, the rows in words, a new scenario, and the
// what-if items a step's menu offers in the scenario being edited.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { type CanvasMenuEntry, canvasMenu } from '../../../src/core/flow/canvasMenu';
import { buildModel } from '../../../src/core/flow/model';
import type { FlowDocument } from '../../../src/core/flow/types';
import {
  newScenario,
  nextScenarioName,
  scenarioChip,
  scenarioMenu,
  scenarioRows,
} from '../../../src/core/scenario/authoring';
import { checkLive, simulatedEnds } from '../../../src/core/scenario/live';

const FIX = join(__dirname, '../../fixtures/engine');
const LEVELS = parse(readFileSync(join(FIX, 'routing-levels.flow.yaml'), 'utf8')) as FlowDocument;
const PORTS = parse(readFileSync(join(FIX, 'routing-ports.flow.yaml'), 'utf8')) as FlowDocument;
const TEXT = readFileSync(join(FIX, 'routing-levels.scenarios.yaml'), 'utf8');
const WRONG = TEXT.replace('h03: gate.failed_hosts', 'h03: done');

const labels = (entries: CanvasMenuEntry[]): unknown[] =>
  entries.map((e) =>
    e.type === 'separator'
      ? '---'
      : e.type === 'submenu'
        ? { [e.label]: labels(e.items) }
        : `${e.label}${e.checked ? ' [x]' : ''}`,
  );

describe('scenarios on the canvas (AFD-116)', () => {
  it('the chip says how they stand, or offers to add some', () => {
    expect(scenarioChip(null).label).toBe('Add Scenarios');
    expect(scenarioChip(checkLive(LEVELS, undefined)).label).toBe('Add Scenarios');
    expect(scenarioChip(checkLive(LEVELS, TEXT))).toMatchObject({
      label: 'Scenarios · 3 pass',
      tone: 'ok',
    });
    expect(scenarioChip(checkLive(LEVELS, WRONG))).toMatchObject({
      label: 'Scenarios · 1 failing',
      tone: 'warn',
    });
    expect(scenarioChip(checkLive(LEVELS, TEXT.replace('gate:', 'nowhere:')))).toMatchObject({
      label: 'Scenarios · fix the file',
      tone: 'error',
    });
  });

  it('a row says what the scenario plants and where a host now ends, in titles', () => {
    const [, , third] = scenarioRows(LEVELS, checkLive(LEVELS, WRONG));
    expect(third).toMatchObject({
      name: 'a failed stage is handled, a failed gate stops the host there',
      hosts: ['h01', 'h02', 'h03', 'h04', 'h05'],
      verdict: 'fail',
      misses: ["h03 now ends at Gate's open failed_hosts; expected Done"],
      planted: ['Prepare fails for h02', 'Gate fails for h03'],
      bestEffort: [],
    });
    expect(third?.verified).toBeUndefined();
  });

  it('a new scenario has hosts on the targets input; the simulation gives its ends', () => {
    const s = newScenario(LEVELS, nextScenarioName(checkLive(LEVELS, TEXT)), 3);
    expect(s).toEqual({
      name: 'Scenario 4',
      inputs: { devices: ['host-01', 'host-02', 'host-03'] },
      expect: {},
    });
    expect(simulatedEnds(LEVELS, s)).toEqual({
      'host-01': 'done',
      'host-02': 'done',
      'host-03': 'done',
    });
    expect(
      simulatedEnds(LEVELS, { ...s, force: { gate: { failed: ['host-02'] } } })['host-02'],
    ).toBe('gate.failed_hosts');
  });

  it('a step offers the outcomes it has; a decision, an approval and an end their own', () => {
    const text = [
      'scenarios:',
      '  - name: what if',
      '    inputs: { devices: [h01, h02] }',
      '    force: { work: { timeout: [h02] } }',
      '    approvals: { approve: rejected }',
      '    expect: { h01: done, h02: done }',
    ].join('\n');
    const menu = scenarioMenu(PORTS, checkLive(PORTS, text), 'what if');
    if (!menu) throw new Error('no menu');
    const model = buildModel(PORTS);
    const id = (key: string) => PORTS.nodes.find((n) => n.key === key)?.id as string;
    const of = (key: string) =>
      labels(
        canvasMenu(
          model,
          { kind: 'node', id: id(key) },
          {
            mode: 'run',
            level: 'root',
            stale: false,
            openPorts: [],
            hasPlay: () => false,
            scenario: menu,
          },
        ),
      )[0];
    expect(of('probe')).toEqual({
      'In "what if"': ['Fail for…', 'Unreachable for…', 'Unchanged for…'],
    });
    expect(of('work')).toEqual({ 'In "what if"': ['Fail for…', 'Time Out for… (h02) [x]'] });
    expect(of('decide')).toEqual({ 'In "what if"': ['Take False for…'] });
    expect(of('approve')).toEqual({
      'In "what if"': [
        'Approved in This Scenario',
        'Rejected in This Scenario [x]',
        'Timed Out in This Scenario',
      ],
    });
    expect(of('done')).toEqual({
      'In "what if"': ['Expect h01 Here [x]', 'Expect h02 Here [x]'],
    });
    // Without a scenario being edited, the menu is as it was.
    const plain = canvasMenu(
      model,
      { kind: 'node', id: id('work') },
      {
        mode: 'run',
        level: 'root',
        stale: false,
        openPorts: [],
        hasPlay: () => false,
      },
    );
    expect(plain[0]?.type === 'item' && plain[0].label).toBe('Details…');
  });
});

// AFD-116: scenarios in the designer: the chip opens the Scenarios tab; rows read in titles; New
// Scenario, Accept New Ends, Undo and the host checklist each ask the host for one change.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { buildModel } from '../../../src/core/flow/model';
import { openFailPorts } from '../../../src/core/flow/openPorts';
import type { FlowDocument } from '../../../src/core/flow/types';
import { checkLive } from '../../../src/core/scenario/live';
import { HostPickDialog } from '../../../src/webview/panels/HostPickDialog';
import { ScenariosPanel } from '../../../src/webview/panels/ScenariosPanel';
import { TopBar } from '../../../src/webview/panels/TopBar';
import { useUi } from '../../../src/webview/store';
import { posted } from './setup';

const FIX = join(__dirname, '../../fixtures/engine');
const doc = parse(readFileSync(join(FIX, 'routing-levels.flow.yaml'), 'utf8')) as FlowDocument;
const TEXT = readFileSync(join(FIX, 'routing-levels.scenarios.yaml'), 'utf8');
const WRONG = TEXT.replace('h03: gate.failed_hosts', 'h03: done');
const THIRD = 'a failed stage is handled, a failed gate stops the host there';
const requests = () =>
  posted
    .filter((m) => (m as { type: string }).type === 'scenarioEdit')
    .map((m) => (m as { request: unknown }).request);

beforeEach(() => {
  posted.length = 0;
  useUi.setState({
    snapshot: null,
    selection: {},
    mode: 'design',
    run: null,
    scenarioCheck: null,
    scenariosOpen: false,
    scenariosTab: false,
    scenarioEditing: null,
    hostPick: null,
  });
  act(() =>
    useUi.getState().setSnapshot({
      docVersion: 1,
      doc,
      stale: false,
      findings: [],
      openPorts: openFailPorts(buildModel(doc)),
      autoPositions: {},
    }),
  );
});
afterEach(cleanup);

describe('scenarios in the designer (AFD-116)', () => {
  it('the chip offers to add scenarios, then says how they stand, and opens the tab', () => {
    render(<TopBar />);
    const chip = () => document.querySelector<HTMLElement>('[data-scenario-chip]');
    expect(chip()?.textContent).toContain('Add Scenarios');
    act(() => useUi.getState().setScenarioCheck(checkLive(doc, WRONG), 0));
    expect(chip()?.textContent).toContain('Scenarios · 1 failing');
    expect(chip()?.dataset.scenarioChip).toBe('warn');
    fireEvent.click(chip() as HTMLElement);
    expect(useUi.getState()).toMatchObject({ scenariosOpen: true, scenariosTab: true });
  });

  it('rows read in titles; Accept New Ends asks the host to expect the new ends', () => {
    act(() => useUi.getState().setScenarioCheck(checkLive(doc, WRONG), 2));
    render(<ScenariosPanel />);
    const row = document.querySelector<HTMLElement>(`[data-scenario="${THIRD}"]`);
    expect(row?.dataset.verdict).toBe('fail');
    expect(row?.textContent).toContain('Prepare fails for h02; Gate fails for h03');
    expect(row?.textContent).toContain("h03 now ends at Gate's open failed_hosts; expected Done");
    fireEvent.click(row?.querySelector('[data-accept-ends]') as HTMLElement);
    expect(requests()).toEqual([{ kind: 'acceptEnds', name: THIRD }]);
    // Two changes made here can be taken back.
    fireEvent.click(screen.getByText('Undo'));
    expect(posted.some((m) => (m as { type: string }).type === 'scenarioUndo')).toBe(true);
    // Verify one in Ansible.
    fireEvent.click(row?.querySelectorAll('button')[2] as HTMLElement);
    expect(posted.at(-1)).toEqual({ type: 'runScenarios', names: [THIRD] });
  });

  it('New Scenario asks for one with hosts on the targets input and no expectations', () => {
    act(() => useUi.getState().setScenarioCheck(checkLive(doc, undefined), 0));
    render(<ScenariosPanel />);
    expect(document.querySelector('[data-scenarios-empty]')).not.toBeNull();
    fireEvent.click(screen.getByText('New Scenario'));
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'gate fails' } });
    fireEvent.change(screen.getByLabelText('Hosts'), { target: { value: '2' } });
    fireEvent.click(screen.getByText('Add Scenario'));
    expect(requests()).toEqual([
      {
        kind: 'add',
        scenario: { name: 'gate fails', inputs: { devices: ['host-01', 'host-02'] }, expect: {} },
      },
    ]);
  });

  it('the host checklist starts from the forced hosts and asks for the ones ticked', () => {
    act(() => {
      useUi.getState().setScenarioCheck(checkLive(doc, TEXT), 0);
      useUi
        .getState()
        .setHostPick({ scenario: THIRD, step: 'gate', outcome: 'failed', title: 'Fail for' });
    });
    render(<HostPickDialog />);
    expect(screen.getByRole('dialog').textContent).toContain('Gate: Fail for…');
    const box = (h: string) => screen.getByLabelText(h) as HTMLInputElement;
    expect(['h01', 'h02', 'h03', 'h04', 'h05'].map((h) => box(h).checked)).toEqual([
      false,
      false,
      true,
      false,
      false,
    ]);
    fireEvent.click(box('h04'));
    fireEvent.click(box('h03'));
    fireEvent.click(screen.getByText('Save'));
    expect(requests()).toEqual([
      { kind: 'force', name: THIRD, step: 'gate', outcome: 'failed', hosts: ['h04'] },
    ]);
  });

  it('a scenario shown on the canvas follows each check, and Done goes back', () => {
    act(() => useUi.getState().setScenarioCheck(checkLive(doc, TEXT), 0));
    act(() => useUi.getState().editScenario(THIRD));
    expect(useUi.getState().mode).toBe('run');
    expect(useUi.getState().run?.scenario?.name).toBe(THIRD);
    expect(useUi.getState().run?.scenario?.passed).toBe(true);
    act(() => useUi.getState().setScenarioCheck(checkLive(doc, WRONG), 1));
    expect(useUi.getState().run?.scenario?.passed).toBe(false);
    act(() => useUi.getState().editScenario(null));
    expect(useUi.getState()).toMatchObject({ scenarioEditing: null, run: null });
  });
});

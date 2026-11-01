// AFD-35: the right panel and the overlays as declared rules.
import { beforeEach, describe, expect, it } from 'vitest';
import { CLOSES, ESCAPE_ORDER } from '../../../src/webview/overlays';
import { rightPanelFor, rightPanelLabel } from '../../../src/webview/rightPanel';
import { PANEL_WIDTH, useUi } from '../../../src/webview/store';

describe('right panel', () => {
  const base = { lens: null, mode: 'design' as const, selection: {}, level: 'root' };
  it.each([
    [{}, { kind: 'flow' }, 'Flow description'],
    [{ level: 'SUB' }, { kind: 'details', id: 'SUB', context: true }, 'Subflow details'],
    [{ selection: { node: 'A' } }, { kind: 'details', id: 'A' }, 'Details'],
    [
      { selection: { nodes: ['A', 'B'] } },
      { kind: 'selection', ids: ['A', 'B'] },
      'Selected nodes',
    ],
    [{ selection: { edge: 'entry:S' } }, { kind: 'boundary', edge: 'entry:S' }, 'Subflow boundary'],
    [{ lens: 'data' }, { kind: 'lens' }, 'Lens findings'],
    [{ lens: 'data', selection: { node: 'A' } }, { kind: 'details', id: 'A' }, 'Details'],
    [{ mode: 'code' }, { kind: 'drift' }, 'Design vs code'],
    // A node shows its Details in every mode; Code and Run add their tab (AFD-43).
    [{ mode: 'code', selection: { node: 'A' } }, { kind: 'details', id: 'A' }, 'Details'],
    [{ mode: 'run' }, { kind: 'run' }, 'Run results'],
    [{ mode: 'run', selection: { edge: 'E1' } }, { kind: 'wireRun', edge: 'E1' }, 'Run results'],
    [{ mode: 'run', selection: { edge: 'exit:S|a|ok|ok' } }, { kind: 'run' }, 'Run results'],
    [{ mode: 'run', selection: { node: 'A' } }, { kind: 'details', id: 'A' }, 'Details'],
  ] as const)('%o → %o', (over, panel, label) => {
    const p = rightPanelFor({ ...base, ...over } as Parameters<typeof rightPanelFor>[0]);
    expect(p).toEqual(panel);
    expect(rightPanelLabel(p)).toBe(label);
  });
});

describe('overlays', () => {
  beforeEach(() =>
    useUi.setState({
      portMenu: null,
      contextMenu: null,
      pick: null,
      quickAdd: null,
      decide: null,
      preview: null,
      detailsTab: 'general',
      pendingBinding: null,
      leave: null,
      cheatSheet: false,
    }),
  );
  const ref = { node: 'A', port: 'failed_hosts' };

  it('opening one closes what the table says, and only that', () => {
    const ui = useUi.getState();
    ui.openPortMenu({ ref, x: 0, y: 0 });
    ui.setDecide(ref);
    expect(useUi.getState()).toMatchObject({ portMenu: null, decide: ref });
    // A reason dialog over a node's Details: both stay.
    ui.openDetails('A');
    ui.setDecide(ref);
    expect(useUi.getState().selection).toEqual({ node: 'A' });
    expect(useUi.getState().decide).toEqual(ref);
    // Another level closes what belonged to the one being left.
    ui.setLevel('SUB');
    expect(useUi.getState().decide).toBeNull();
    for (const o of CLOSES.level) expect(useUi.getState()[o]).toBeFalsy();
  });

  it('Escape closes the innermost first', () => {
    expect(ESCAPE_ORDER[0]).toBe('contextMenu');
  });
});

describe('the side panel (AFD-43)', () => {
  it('keeps its width between the bounds; expanding does not change it', () => {
    const ui = useUi.getState();
    ui.setPanelWidth(10);
    expect(useUi.getState().panelWidth).toBe(PANEL_WIDTH.min);
    ui.setPanelWidth(5000);
    expect(useUi.getState().panelWidth).toBe(PANEL_WIDTH.max);
    ui.setPanelWidth(400.4);
    ui.setExpanded(true);
    expect(useUi.getState()).toMatchObject({ panelWidth: 400, expanded: true });
    ui.setExpanded(false);
  });
});

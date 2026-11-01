// AFD-35: the right panel and the overlays as declared rules.
import { beforeEach, describe, expect, it } from 'vitest';
import { CLOSES, ESCAPE_ORDER } from '../../../src/webview/overlays';
import { rightPanelFor, rightPanelLabel } from '../../../src/webview/rightPanel';
import { useUi } from '../../../src/webview/store';

describe('right panel', () => {
  const base = { lens: null, mode: 'design' as const, selection: {}, level: 'root' };
  it.each([
    [{}, { kind: 'flow' }, 'Flow description'],
    [{ level: 'SUB' }, { kind: 'inspector', id: 'SUB', context: true }, 'Subflow description'],
    [{ selection: { node: 'A' } }, { kind: 'inspector', id: 'A' }, 'Node inspector'],
    [
      { selection: { nodes: ['A', 'B'] } },
      { kind: 'selection', ids: ['A', 'B'] },
      'Selected nodes',
    ],
    [{ selection: { edge: 'entry:S' } }, { kind: 'boundary', edge: 'entry:S' }, 'Subflow boundary'],
    [{ lens: 'data' }, { kind: 'lens' }, 'Lens findings'],
    [{ lens: 'data', selection: { node: 'A' } }, { kind: 'inspector', id: 'A' }, 'Node inspector'],
    [{ mode: 'code' }, { kind: 'drift' }, 'Design vs code'],
    [{ mode: 'code', selection: { node: 'A' } }, { kind: 'nodeCode', id: 'A' }, 'Design vs code'],
    [{ mode: 'run' }, { kind: 'run' }, 'Run results'],
    [{ mode: 'run', selection: { edge: 'E1' } }, { kind: 'wireRun', edge: 'E1' }, 'Run results'],
    [{ mode: 'run', selection: { edge: 'exit:S|a|ok|ok' } }, { kind: 'run' }, 'Run results'],
    [{ mode: 'run', selection: { node: 'A' } }, { kind: 'nodeRun', id: 'A' }, 'Run results'],
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
      properties: null,
      cheatSheet: false,
    }),
  );
  const ref = { node: 'A', port: 'failed_hosts' };

  it('opening one closes what the table says, and only that', () => {
    const ui = useUi.getState();
    ui.openPortMenu({ ref, x: 0, y: 0 });
    ui.setDecide(ref);
    expect(useUi.getState()).toMatchObject({ portMenu: null, decide: ref });
    // A reason dialog over the properties page: both stay open.
    ui.openProperties('A');
    ui.setDecide(ref);
    expect(useUi.getState().properties?.node).toBe('A');
    expect(useUi.getState().decide).toEqual(ref);
    // Another level closes what belonged to the one being left.
    ui.setLevel('SUB');
    expect(useUi.getState().decide).toBeNull();
    for (const o of CLOSES.level) expect(useUi.getState()[o]).toBeFalsy();
  });

  it('Escape closes the innermost first; the properties page closes itself', () => {
    expect(ESCAPE_ORDER[0]).toBe('contextMenu');
    expect(ESCAPE_ORDER).not.toContain('properties');
  });
});

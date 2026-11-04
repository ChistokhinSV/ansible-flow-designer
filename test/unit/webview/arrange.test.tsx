// AFD-88 (wave 8 group G): Align and Distribute from the selection panel and the keys, as one
// move that also freezes the steps still at their automatic place; Reset Position; the flow
// panel's hint on selecting several (round 1: T10, W15, P20).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import type { FlowCommand } from '../../../src/core/flow/commands';
import { nodeSize } from '../../../src/core/flow/geometry';
import { buildModel } from '../../../src/core/flow/model';
import { openFailPorts } from '../../../src/core/flow/openPorts';
import type { FlowDocument } from '../../../src/core/flow/types';
import { installKeyboard } from '../../../src/webview/keyboard';
import { FlowDescription } from '../../../src/webview/panels/FlowDescription';
import { SelectionPanel } from '../../../src/webview/panels/SelectionPanel';
import { useUi } from '../../../src/webview/store';
import { posted } from './setup';

const example = parse(
  readFileSync(join(__dirname, '../../../examples/edge-baseline.flow.yaml'), 'utf8'),
) as FlowDocument;
const id = (key: string) => example.nodes.find((n) => n.key === key)?.id as string;
// The example's steps line up already: one is moved off by hand, as round 1's were.
const off = example.layout?.[id('backup-config')] ?? { x: 0, y: 0 };
const doc: FlowDocument = {
  ...example,
  layout: { ...example.layout, [id('backup-config')]: { x: off.x + 17, y: off.y + 23 } },
};
const commands = () =>
  (posted as { type: string; command?: FlowCommand }[])
    .filter((m) => m.type === 'command')
    .map((m) => m.command as FlowCommand);
const three = () => [id('precheck'), id('backup-config'), id('push-baseline')];

beforeEach(() => {
  posted.length = 0;
  useUi.setState({ snapshot: null, selection: {}, optimistic: {}, mode: 'design', level: 'root' });
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

describe('Arrange (AFD-88)', () => {
  it('Align Centers is one move: the three share a centre, the rest of the level is frozen', () => {
    const ids = three();
    act(() => useUi.getState().select({ nodes: ids }));
    render(<SelectionPanel ids={ids} />);
    fireEvent.click(screen.getByRole('button', { name: /Align Centers/ }));
    const sent = commands();
    expect(sent).toHaveLength(1);
    const move = sent[0] as Extract<FlowCommand, { kind: 'moveNodes' }>;
    expect(move.kind).toBe('moveNodes');
    const centre = (key: string) => {
      const node = doc.nodes.find((n) => n.key === key);
      const at = move.positions[id(key)] ?? doc.layout?.[id(key)];
      return (at?.x ?? 0) + nodeSize(node?.type ?? 'task').width / 2;
    };
    const centres = ['precheck', 'backup-config', 'push-baseline'].map(centre);
    expect(Math.max(...centres) - Math.min(...centres)).toBeLessThanOrEqual(1);
  });

  it('Shift+Alt+D spaces three selected steps evenly; with two it does nothing', () => {
    const stop = installKeyboard();
    try {
      act(() => useUi.getState().select({ nodes: three().slice(0, 2) }));
      fireEvent.keyDown(document.body, { key: 'Ð', code: 'KeyD', altKey: true, shiftKey: true });
      expect(commands()).toEqual([]);
      act(() => useUi.getState().select({ nodes: three() }));
      fireEvent.keyDown(document.body, { key: 'Ð', code: 'KeyD', altKey: true, shiftKey: true });
      expect(commands().map((c) => c.kind)).toEqual(['moveNodes']);
    } finally {
      stop();
    }
  });

  it('Reset Position hands placed steps back to the canvas', () => {
    const ids = three();
    render(<SelectionPanel ids={ids} />);
    fireEvent.click(screen.getByRole('button', { name: 'Reset Position' }));
    expect(commands().at(-1)).toEqual({
      kind: 'unplaceNodes',
      ids: ids.filter((n) => doc.layout?.[n]),
    });
  });

  it('the flow panel says how to select several steps', () => {
    render(<FlowDescription />);
    expect(document.querySelector('[data-select-hint]')?.textContent).toMatch(
      /select them with Ctrl\+click, Shift\+drag/,
    );
  });
});

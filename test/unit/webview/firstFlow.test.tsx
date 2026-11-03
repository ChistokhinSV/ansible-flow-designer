// AFD-73: the first-flow checklist card: its count, Show Me, and hiding it for good.
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { planCommand } from '../../../src/core/flow/commands';
import { createIdFactory } from '../../../src/core/flow/ids';
import { modelOf } from '../../../src/core/flow/model';
import { openFailPorts } from '../../../src/core/flow/openPorts';
import { newFlowText } from '../../../src/core/flow/template';
import type { FlowDocument } from '../../../src/core/flow/types';
import { FirstFlow } from '../../../src/webview/panels/FirstFlow';
import { useUi } from '../../../src/webview/store';
import { posted } from './setup';

const ctx = { newId: createIdFactory() };
const fresh = newFlowText('NTP baseline', 'ntp-baseline', ctx.newId);
const wire = (parse(fresh) as FlowDocument).edges?.[0]?.id as string;
const added = planCommand(
  fresh,
  { kind: 'addNode', type: 'task', title: 'Check NTP', insertOn: wire },
  ctx,
);
const doc = parse(added.text) as FlowDocument;

function show(state: { hidden: boolean; done: string[] }) {
  act(() => {
    useUi.setState({ mode: 'design', level: 'root', firstFlow: state });
    useUi.getState().setSnapshot({
      docVersion: 1,
      doc,
      stale: false,
      findings: [],
      openPorts: openFailPorts(modelOf(doc)),
      autoPositions: {},
    });
  });
}

beforeEach(() => {
  posted.length = 0;
});
afterEach(cleanup);

describe('first-flow checklist (AFD-73)', () => {
  it('counts what is done; Show Me peeks at the first step; Hide hides it for good', () => {
    show({ hidden: false, done: [] });
    render(<FirstFlow />);
    expect(screen.getByText('Your first flow · 1 of 4')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Show me: See the playbook it makes' }));
    expect(posted).toContainEqual({ type: 'peekCode', node: added.created });
    expect(useUi.getState().selection.node).toBe(added.created);
    fireEvent.click(screen.getByRole('button', { name: 'Show me: Run it as a skeleton' }));
    expect(posted).toContainEqual({ type: 'run', mode: 'check' });
    fireEvent.click(screen.getByRole('button', { name: 'Hide Checklist' }));
    expect(posted).toContainEqual({ type: 'firstFlow', hidden: true });
  });

  it('is not there once hidden, nor in Run mode', () => {
    show({ hidden: true, done: [] });
    const { container } = render(<FirstFlow />);
    expect(container.textContent).toBe('');
    act(() => useUi.setState({ mode: 'run', firstFlow: { hidden: false, done: [] } }));
    expect(container.textContent).toBe('');
  });
});

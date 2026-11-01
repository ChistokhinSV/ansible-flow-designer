// AFD-49: a format 1 flow shows the format banner with Upgrade Flow Format; the button sends the
// upgrade as one command; a current flow, a broken file or a closed banner shows none.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { planCommand } from '../../../src/core/flow/commands';
import { createIdFactory } from '../../../src/core/flow/ids';
import { CURRENT_FORMAT } from '../../../src/core/flow/migrate';
import { buildModel } from '../../../src/core/flow/model';
import { openFailPorts } from '../../../src/core/flow/openPorts';
import type { FlowDocument, FlowNode } from '../../../src/core/flow/types';
import { Details } from '../../../src/webview/details/Details';
import { Lifecycle } from '../../../src/webview/details/sections';
import { FormatBanner } from '../../../src/webview/panels/Banner';
import { AcceptDialog } from '../../../src/webview/panels/LensPanel';
import { useUi } from '../../../src/webview/store';
import { posted } from './setup';

const v1 = parse(
  readFileSync(join(__dirname, '../../../examples/edge-baseline.flow.yaml'), 'utf8'),
) as FlowDocument;

function show(doc: FlowDocument, stale = false) {
  act(() =>
    useUi.getState().setSnapshot({
      docVersion: Date.now(),
      doc,
      stale,
      findings: [],
      openPorts: openFailPorts(buildModel(doc)),
      autoPositions: {},
    }),
  );
}

beforeEach(() => {
  posted.length = 0;
  useUi.setState({ snapshot: null, formatDismissed: false });
});
afterEach(cleanup);

describe('the format banner', () => {
  it('offers Upgrade Flow Format on a format 1 flow and sends one command', () => {
    show(v1);
    render(<FormatBanner />);
    const banner = document.querySelector('[data-format-banner]') as HTMLElement;
    expect(banner.textContent).toContain('Flow format 1.');
    expect(banner.textContent).toContain('One undo step reverts it.');
    fireEvent.click(screen.getByRole('button', { name: 'Upgrade Flow Format' }));
    expect(posted).toContainEqual(
      expect.objectContaining({ type: 'command', command: { kind: 'upgradeFormat' } }),
    );
  });

  it('is not there on a current flow, on a broken file, or once closed', () => {
    show({ ...v1, schema_version: CURRENT_FORMAT as 2 });
    const { rerender } = render(<FormatBanner />);
    expect(document.querySelector('[data-format-banner]')).toBeNull();
    show(v1, true);
    rerender(<FormatBanner />);
    expect(document.querySelector('[data-format-banner]')).toBeNull();
    show(v1);
    rerender(<FormatBanner />);
    fireEvent.click(screen.getByRole('button', { name: 'Hide the format message' }));
    expect(document.querySelector('[data-format-banner]')).toBeNull();
  });
});

describe('the lifecycle in format 2 (AFD-50)', () => {
  const v2 = parse(
    planCommand(
      readFileSync(join(__dirname, '../../../examples/edge-baseline.flow.yaml'), 'utf8'),
      { kind: 'upgradeFormat' },
      { newId: createIdFactory() },
    ).text,
  ) as FlowDocument;
  const push = v2.nodes.find((n) => n.key === 'push-baseline') as FlowNode;

  it('shows the status the content gives, with Mark Tested… for implemented content', () => {
    show(v2);
    const set: string[] = [];
    render(<Lifecycle node={push} onSet={(s) => set.push(s)} />);
    expect(document.querySelector('[data-lifecycle="derived"]')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'implemented' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Mark Tested/ }));
    expect(set).toEqual(['tested']);
  });

  it('a tested node shows its record and Clear Tested goes back to what the content gives', () => {
    const tested: FlowNode = {
      ...push,
      status: 'tested',
      tested: { run: 'r7', flow_version: 3, commit: 'abc1234def5678' },
    };
    show({ ...v2, nodes: v2.nodes.map((n) => (n.id === push.id ? tested : n)) });
    const set: string[] = [];
    render(<Lifecycle node={tested} onSet={(s) => set.push(s)} />);
    expect(document.querySelector('[data-tested-record]')?.textContent).toBe(
      'Tested by run r7 of flow version 3 at abc1234def',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Clear Tested' }));
    expect(set).toEqual(['implemented']);
  });
});

describe('accepting a problem in format 2 (AFD-51)', () => {
  it('a warning in the Details has Accept…, which records an accepted problem', () => {
    const text = planCommand(
      readFileSync(join(__dirname, '../../../examples/edge-baseline.flow.yaml'), 'utf8'),
      { kind: 'upgradeFormat' },
      { newId: createIdFactory() },
    ).text;
    const doc = parse(text) as FlowDocument;
    const node = doc.nodes.find((n) => n.key === 'precheck') as FlowNode;
    const warning = {
      code: 'binding-unknown-var',
      severity: 'warning' as const,
      message: 'Pre-checks reads "ntp_servers", which is not an input of this node',
      path: ['nodes', 1, 'impl', 'params'],
      node: node.id,
      subject: 'ntp_servers',
    };
    act(() =>
      useUi.getState().setSnapshot({
        docVersion: Date.now(),
        doc,
        stale: false,
        findings: [warning],
        openPorts: openFailPorts(buildModel(doc)),
        autoPositions: {},
      }),
    );
    useUi.setState({ accept: null, mode: 'design' });
    render(
      <>
        <Details id={node.id} />
        <AcceptDialog />
      </>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Accept…' }));
    fireEvent.change(screen.getByRole('textbox', { name: /Reason/ }), {
      target: { value: 'Set in group_vars/edge.yml' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Accept' }));
    expect(posted).toContainEqual(
      expect.objectContaining({
        type: 'command',
        command: {
          kind: 'acceptCheck',
          node: node.id,
          code: 'binding-unknown-var',
          subject: 'ntp_servers',
          reason: 'Set in group_vars/edge.yml',
        },
      }),
    );
  });
});

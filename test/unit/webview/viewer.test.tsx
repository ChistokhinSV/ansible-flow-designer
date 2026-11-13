// AFD-270: the designer as a viewer: it shows the flow and runs it, and nothing that changes the
// flow leaves the page.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { parseFlow } from '../../../src/core/flow/document';
import type { HostMessage, Snapshot, WebviewMessage } from '../../../src/core/protocol';
import { VIEWER_MESSAGES, VIEWER_REFUSAL, viewerAllows } from '../../../src/core/viewer';
import { App } from '../../../src/webview/App';
import { command, scenarioUndo, send, setTransport } from '../../../src/webview/bus';
import { useUi } from '../../../src/webview/store';
import type { DesignerTransport } from '../../../src/webview/transport';

/** A flow as a host would send it, without the parts a viewer test does not look at. */
function snapshotOf(): Snapshot {
  const text = readFileSync(join(process.cwd(), 'examples/edge-baseline.flow.yaml'), 'utf8');
  const doc = parseFlow(text).doc;
  if (!doc) throw new Error('the example flow did not parse');
  return { docVersion: 1, doc, stale: false, findings: [], openPorts: [], autoPositions: {} };
}

function fakeHost() {
  const posted: WebviewMessage[] = [];
  const listeners = new Set<(m: HostMessage) => void>();
  const transport: DesignerTransport = {
    post: (m) => posted.push(m),
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getState: () => undefined,
    setState: () => undefined,
  };
  const say = (m: HostMessage) => {
    for (const l of listeners) l(m);
  };
  return { transport, posted, say };
}

afterEach(cleanup);

describe('AFD-270: what a viewer may send', () => {
  it('allows showing and running, and nothing that changes the flow or its files', () => {
    for (const type of ['ready', 'run', 'launchRun', 'stopRun', 'showRun', 'runOutput', 'approve'])
      expect(viewerAllows(type)).toBe(true);
    for (const type of [
      'command',
      'driftAction',
      'scenarioEdit',
      'scenarioUndo',
      'generate',
      'tidyUp',
      'completeIds',
      'initFlow',
      'export',
      'openText',
      'launchAwx',
      'launchSwitch',
      'runPartial',
      'runScenarios',
    ])
      expect(viewerAllows(type)).toBe(false);
    expect(VIEWER_MESSAGES.size).toBeGreaterThan(8);
  });
});

describe('AFD-270: the designer as a viewer', () => {
  it('stays in Run mode, hides the editing controls, and posts no change', async () => {
    const host = fakeHost();
    setTransport(host.transport);
    render(<App />);
    await act(async () => {
      host.say({ type: 'config', testMode: false, viewer: true });
      host.say({ type: 'snapshot', snapshot: snapshotOf() });
    });

    // Run mode, and no way out of it: not by the store, not by the host.
    expect(useUi.getState().viewer).toBe(true);
    expect(useUi.getState().mode).toBe('run');
    useUi.getState().setMode('design');
    await act(async () => host.say({ type: 'setMode', mode: 'design' }));
    expect(useUi.getState().mode).toBe('run');

    // The bar keeps the run button and drops what changes the flow.
    expect(screen.getByRole('button', { name: /Run as Skeleton/ })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Generate Code/ })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Design' })).toBeNull();
    expect(screen.queryByRole('complementary', { name: /Palette|Nodes/ })).toBeNull();

    // A change is refused in the page; the host never hears of it.
    const before = host.posted.length;
    await expect(command({ kind: 'deleteNodes', ids: [] } as never)).resolves.toEqual({
      ok: false,
      error: VIEWER_REFUSAL,
    });
    await expect(scenarioUndo()).resolves.toMatchObject({ ok: false });
    send({ type: 'generate' });
    send({ type: 'tidyUp', level: 'root' });
    expect(host.posted.length).toBe(before);

    // A run still goes out.
    send({ type: 'run', mode: 'check' });
    expect(host.posted.at(-1)).toEqual({ type: 'run', mode: 'check' });

    // A later config without the flag does not hand the editor back.
    await act(async () => host.say({ type: 'config', testMode: false }));
    expect(useUi.getState().viewer).toBe(true);
  });
});

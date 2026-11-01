// AFD-46: feedback. Messages stack over the canvas and close by hand or in time; the host's
// messages land there; "Saving…" shows only while an edit waits; a broken file says it is read-only.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parse } from 'yaml';
import { buildModel, ROOT } from '../../../src/core/flow/model';
import { openFailPorts } from '../../../src/core/flow/openPorts';
import type { FlowDocument } from '../../../src/core/flow/types';
import type { Snapshot } from '../../../src/core/protocol';
import { App } from '../../../src/webview/App';
import { command } from '../../../src/webview/bus';
import { SAVING_DELAY_MS, Toasts } from '../../../src/webview/panels/Toasts';
import { TOAST_MS, useUi } from '../../../src/webview/store';
import { posted } from './setup';

const doc = parse(
  readFileSync(join(__dirname, '../../../examples/os-upgrade.flow.yaml'), 'utf8'),
) as FlowDocument;

function snapshotOf(over: Partial<Snapshot> = {}): Snapshot {
  return {
    docVersion: 1,
    doc,
    stale: false,
    findings: [],
    openPorts: openFailPorts(buildModel(doc)),
    autoPositions: {},
    ...over,
  };
}

const fromHost = (data: unknown) =>
  act(() => {
    window.dispatchEvent(new MessageEvent('message', { data }));
  });
const shown = () => [...document.querySelectorAll<HTMLElement>('[data-toast]')];
const notify = useUi.getState().notify;

beforeEach(() => {
  posted.length = 0;
  useUi.setState({ snapshot: null, toasts: [], saving: false, level: ROOT, mode: 'design' });
  act(() => useUi.getState().setSnapshot(snapshotOf()));
});
afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

describe('messages over the canvas', () => {
  it('stack newest last, errors as alerts, each with a close button', () => {
    render(<Toasts />);
    act(() => {
      notify('info', 'Copied 2 nodes');
      notify('error', 'The clipboard does not hold flow nodes');
    });
    expect(shown().map((t) => t.dataset.toast)).toEqual(['info', 'error']);
    expect(screen.getByRole('alert').textContent).toContain('does not hold flow nodes');
    fireEvent.click(
      within(shown()[0] as HTMLElement).getByRole('button', { name: 'Close message' }),
    );
    expect(shown().map((t) => t.textContent)).toEqual(['The clipboard does not hold flow nodes']);
  });

  it('close on their own in time, errors later than the rest', () => {
    vi.useFakeTimers();
    render(<Toasts />);
    act(() => {
      notify('success', 'Tidied up the level');
      notify('error', 'Tidy Up failed');
    });
    act(() => vi.advanceTimersByTime(TOAST_MS.success));
    expect(shown().map((t) => t.dataset.toast)).toEqual(['error']);
    act(() => vi.advanceTimersByTime(TOAST_MS.error - TOAST_MS.success));
    expect(shown()).toEqual([]);
  });

  it('say the same thing once, and keep at most four', () => {
    act(() => {
      notify('success', 'Tidied up the level');
      notify('success', 'Tidied up the level');
    });
    expect(useUi.getState().toasts).toHaveLength(1);
    act(() => {
      for (const n of [1, 2, 3, 4, 5]) notify('info', `Message ${n}`);
    });
    expect(useUi.getState().toasts.map((t) => t.text)).toEqual([
      'Message 2',
      'Message 3',
      'Message 4',
      'Message 5',
    ]);
  });

  it("show the host's word on Generate, Check and Tidy Up", () => {
    render(<App />);
    fromHost({ type: 'notify', level: 'success', text: 'Generated 2 file(s) in flows/generated' });
    expect(shown().map((t) => [t.dataset.toast, t.textContent])).toEqual([
      ['success', 'Generated 2 file(s) in flows/generated'],
    ]);
  });
});

describe('Saving…', () => {
  const ack = (ok = true) => {
    const m = posted.filter((p) => (p as { type: string }).type === 'command').at(-1) as {
      reqId: number;
    };
    fromHost({ type: 'ack', reqId: m.reqId, ok });
  };
  const saving = () => document.querySelector('[data-saving]');

  it('shows while an edit waits for the host, and goes when it is answered', async () => {
    render(<App />);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let done: Promise<unknown> = Promise.resolve();
    act(() => {
      done = command({ kind: 'tidyUp', positions: {} });
    });
    expect(useUi.getState().saving).toBe(true);
    act(() => vi.advanceTimersByTime(SAVING_DELAY_MS - 50));
    expect(saving()).toBeNull();
    act(() => vi.advanceTimersByTime(100));
    expect(saving()?.textContent).toContain('Saving…');
    ack();
    await act(() => done);
    expect(useUi.getState().saving).toBe(false);
    expect(saving()).toBeNull();
  });

  it('says nothing for a quick edit', async () => {
    render(<App />);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let done: Promise<unknown> = Promise.resolve();
    act(() => {
      done = command({ kind: 'tidyUp', positions: {} });
    });
    ack();
    await act(() => done);
    act(() => vi.advanceTimersByTime(SAVING_DELAY_MS * 2));
    expect(saving()).toBeNull();
  });
});

describe('a file with YAML errors', () => {
  it('says the designer is read-only and opens the text to fix it', () => {
    act(() =>
      useUi
        .getState()
        .setSnapshot(snapshotOf({ stale: true, parseError: 'line 3: bad indentation' })),
    );
    render(<App />);
    const banner = document.querySelector('[data-read-only-banner]') as HTMLElement;
    expect(banner.textContent).toContain('Read-only:');
    expect(banner.textContent).toContain('line 3: bad indentation');
    fireEvent.click(within(banner).getByRole('button', { name: 'Open in Text Editor' }));
    expect(posted).toContainEqual({ type: 'openText' });
  });
});

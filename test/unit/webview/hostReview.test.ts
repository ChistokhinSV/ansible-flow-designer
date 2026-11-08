// AFD-125, host and designer group (AFD-152..157): requests that always end, commands that do not
// race, and designer state that survives. Each case is a finding of the 0.74.1 code review.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { command, onInFlight, REQUEST_TIMEOUT_MS } from '../../../src/webview/bus';
import { useUi } from '../../../src/webview/store';

afterEach(() => {
  vi.useRealTimers();
});

describe('AFD-156: a move the host refused does not stay on the canvas', () => {
  it('drops the positions that move set, and keeps one a later move set since', () => {
    const ui = useUi.getState();
    ui.setOptimistic({ a: { x: 10, y: 20 }, b: { x: 30, y: 40 } });
    // A later drag moved b again before the first move's answer came back.
    ui.setOptimistic({ b: { x: 99, y: 99 } });
    useUi.getState().dropOptimistic({ a: { x: 10, y: 20 }, b: { x: 30, y: 40 } });
    expect(useUi.getState().optimistic).toEqual({ b: { x: 99, y: 99 } });
    useUi.getState().dropOptimistic({ b: { x: 99, y: 99 } });
    expect(useUi.getState().optimistic).toEqual({});
  });
});

describe('AFD-152: a request VS Code never answers ends', () => {
  it('resolves not ok after the timeout, and the in-flight count goes back to 0', async () => {
    vi.useFakeTimers();
    const counts: number[] = [];
    const off = onInFlight((n) => counts.push(n));
    const answer = command({ kind: 'deleteNodes', ids: [] } as never);
    expect(counts.at(-1)).toBe(1);
    vi.advanceTimersByTime(REQUEST_TIMEOUT_MS);
    await expect(answer).resolves.toMatchObject({ ok: false, error: /did not answer/ });
    expect(counts.at(-1)).toBe(0);
    off();
  });

  it('an answer before the timeout wins, and the timeout does nothing later', async () => {
    vi.useFakeTimers();
    const answer = command({ kind: 'deleteNodes', ids: [] } as never);
    const posted = (await import('./setup')).posted;
    const sent = posted.at(-1) as { reqId: number };
    window.dispatchEvent(
      new MessageEvent('message', { data: { type: 'ack', reqId: sent.reqId, ok: true } }),
    );
    await expect(answer).resolves.toMatchObject({ ok: true });
    vi.advanceTimersByTime(REQUEST_TIMEOUT_MS);
    await expect(answer).resolves.toMatchObject({ ok: true });
  });
});

// AFD-38: requests a designer panel answers later by id.
import { describe, expect, it } from 'vitest';
import { RequestTracker } from '../../../src/extension/session/requests';

describe('request tracker', () => {
  it('matches answers to requests by id and ignores unknown or late ones', async () => {
    const tracker = new RequestTracker<string>();
    const sent: number[] = [];
    const a = tracker.request((id) => sent.push(id), 1_000, 'a');
    const b = tracker.request((id) => sent.push(id), 1_000, 'b');
    expect(sent).toEqual([1, 2]);
    tracker.answer(2, 'second');
    tracker.answer(1, 'first');
    tracker.answer(99, 'nobody asked');
    await expect(a).resolves.toBe('first');
    await expect(b).resolves.toBe('second');
  });

  it('fails a request nobody answers in time', async () => {
    const tracker = new RequestTracker<string>();
    const late = tracker.request(() => {}, 20, 'drawing the PNG');
    await expect(late).rejects.toThrow('drawing the PNG timed out');
    // The answer after the timeout changes nothing.
    tracker.answer(1, 'too late');
  });
});

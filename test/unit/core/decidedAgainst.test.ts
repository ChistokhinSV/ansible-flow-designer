// AFD-359: a run whose hosts a decision sent to a failed end reads as that decision on a server's
// pages, and the host lines leave the step keys out.
import { describe, expect, it } from 'vitest';
import { decidedAgainst, outcomeWords } from '../../../src/core/run/words';

const REJECTED =
  'Rejected at [approve] Change approval. Ended at [not-approved] Not approved (outcome: failed)';
const LATE =
  'No decision in time at [approve] Change approval. Ended at [not-approved] Not approved (outcome: failed)';
const BROKE = 'Ended at [failed] Failed (outcome: failed)';

describe('decidedAgainst', () => {
  it('is the decision when every failing host ended through it', () => {
    expect(decidedAgainst({ outcome: { h1: REJECTED }, failures: [] })).toBe('rejected');
    expect(decidedAgainst({ outcome: { h1: LATE }, failures: [] })).toBe('timed out');
    expect(decidedAgainst({ outcome: { h1: REJECTED, h2: LATE }, failures: [] })).toBe('rejected');
  });

  it('is nothing when a host failed otherwise, or none failed', () => {
    expect(decidedAgainst({ outcome: { h1: REJECTED, h2: BROKE }, failures: [] })).toBeUndefined();
    expect(decidedAgainst({ outcome: { h1: REJECTED }, failures: [{}] })).toBeUndefined();
    expect(
      decidedAgainst({ outcome: { h1: REJECTED }, failures: [], unreachable: ['h2'] }),
    ).toBeUndefined();
    expect(decidedAgainst({ outcome: {}, failures: [] })).toBeUndefined();
  });
});

describe('outcomeWords', () => {
  it("in a server's words: no step keys, and the decision as the outcome", () => {
    expect(outcomeWords(REJECTED, 'server')).toBe(
      'Rejected at Change approval. Ended at Not approved (outcome: rejected)',
    );
    expect(outcomeWords(LATE, 'server')).toBe(
      'No decision in time at Change approval. Ended at Not approved (outcome: not decided in time)',
    );
    expect(outcomeWords(BROKE, 'server')).toBe('Ended at Failed (outcome: failed)');
  });

  it("in the designer's words: as the generator wrote it", () => {
    expect(outcomeWords(REJECTED, 'designer')).toBe(REJECTED);
  });
});

// AFD-103 (round 3: R2): an until that compares the whole registered result never holds.
import { describe, expect, it } from 'vitest';
import { comparesWholeResult } from '../../../src/core/flow/until';

describe('comparesWholeResult', () => {
  const r = 'wait_policy_result';
  it.each([
    'wait_policy_result == "installed"',
    "'installed' in wait_policy_result",
    'wait_policy_result != 0',
    'wait_policy_result in ["ok"]',
  ])('flags %s', (expr) => expect(comparesWholeResult(expr, r)).toBe(true));

  it.each([
    "'installed' in wait_policy_result.stdout",
    'wait_policy_result is succeeded',
    "wait_policy_result['stdout'] == 'x'",
    'wait_policy_result | length > 0',
    'wait_policy_result.rc == 0 and ready == true',
    "'wait_policy_result' in names",
    'other_result == "installed"',
  ])('leaves %s', (expr) => expect(comparesWholeResult(expr, r)).toBe(false));
});

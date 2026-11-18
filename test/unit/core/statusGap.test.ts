// AFD-334: a step implemented by its binding that would not run is shown specified, with why.
import { describe, expect, it } from 'vitest';
import { gapWords, missingRole, shownStatus } from '../../../src/core/view/statusGap';

describe('status gap (AFD-334)', () => {
  it('implemented with a gap reads specified; other statuses stay', () => {
    expect(shownStatus('implemented', { params: ['banner'] })).toBe('specified');
    expect(shownStatus('implemented', { params: [], role: 'netops_backup' })).toBe('specified');
    expect(shownStatus('implemented', { params: [] })).toBe('implemented');
    expect(shownStatus('tested', { params: ['banner'] })).toBe('tested');
    expect(shownStatus('draft', undefined)).toBe('draft');
  });

  it('says what is missing', () => {
    expect(gapWords({ params: ['banner'] })).toBe('Required parameter missing: banner');
    expect(gapWords({ params: ['a', 'b'], role: 'r' })).toBe(
      'Required parameters missing: a, b; Role r is not in this project',
    );
  });

  it("reads the host's role-missing finding of a node", () => {
    const findings = [
      {
        code: 'role-missing',
        severity: 'warning' as const,
        message: '',
        path: [],
        node: 'n1',
        subject: 'x',
      },
    ];
    expect(missingRole(findings, 'n1')).toBe('x');
    expect(missingRole(findings, 'n2')).toBeUndefined();
  });
});

// AFD-334: a step implemented by its binding that would not run is shown specified, with why.
import { describe, expect, it } from 'vitest';
import { gapWords, missingRole, runFailures, shownStatus } from '../../../src/core/view/statusGap';

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

  it('AFD-360: findings that fail every host at run time make a gap too', () => {
    const finding = (code: string, severity: 'warning' | 'info', subject: string) => ({
      code,
      severity,
      message: '',
      path: [],
      node: 'n1',
      subject,
    });
    const cli = { id: 'n1', impl: { kind: 'module', ref: 'ansible.netcommon.cli_command' } };
    const assert = { id: 'n1', impl: { kind: 'module', ref: 'ansible.builtin.assert' } };
    const local = [finding('binding-connection-local', 'warning', 'ansible_connection')];
    expect(runFailures(local, cli)).toEqual([
      'The inventory connects to its hosts locally (ansible_connection: local)',
    ]);
    const unknown = [finding('binding-unknown-var', 'warning', 'ntp_status')];
    expect(runFailures(unknown, assert)).toEqual(['It asserts on ntp_status, which nothing sets']);
    // Elsewhere an unknown read is a warning to look at, not a sure failure; info never counts.
    expect(runFailures(unknown, cli)).toEqual([]);
    expect(runFailures([finding('binding-unknown-var', 'info', 'x')], assert)).toEqual([]);
    expect(shownStatus('implemented', { params: [], fails: ['x'] })).toBe('specified');
  });
});

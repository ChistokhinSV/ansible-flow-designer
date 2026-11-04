// AFD-79: Run Scenarios writes ansible-playbook's lines to the log channel, which shows escape codes
// as text; the run's colours (ANSIBLE_FORCE_COLOR, for the terminal) are stripped there.
import { describe, expect, it } from 'vitest';
import { stripAnsi } from '../../../src/core/run/ansi';

const ESC = String.fromCharCode(27);

describe('stripAnsi', () => {
  it('drops colour codes and keeps the text', () => {
    const red = `${ESC}[0;31mfatal: [lab-sw-04]: FAILED!${ESC}[0m`;
    expect(stripAnsi(red)).toBe('fatal: [lab-sw-04]: FAILED!');
    expect(stripAnsi(`${ESC}[1;35m[WARNING]: no inventory${ESC}[0m`)).toBe(
      '[WARNING]: no inventory',
    );
  });

  it('leaves text without escapes as it is, brackets included', () => {
    const line = 'ok: [lab-sw-01] => {"msg": "[0;31m is not a code without ESC"}';
    expect(stripAnsi(line)).toBe(line);
  });
});

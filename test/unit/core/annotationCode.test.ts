// AFD-66: a Note on a node is a comment above that node's code: plain text, every line commented,
// outside the node's play range; no line break in it can end the comment and become YAML.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { optionA } from '../../../src/core/engine/optionA';
import { planCommand } from '../../../src/core/flow/commands';
import { createIdFactory } from '../../../src/core/flow/ids';
import { withoutAnnotations } from '../../../src/core/flow/semantic';
import type { FlowDocument } from '../../../src/core/flow/types';

const TEXT = readFileSync(join(__dirname, '../../fixtures/flows/annotated.flow.yaml'), 'utf8');
const doc = (t: string) => parse(t) as FlowDocument;
const gen = (t: string) => {
  const r = optionA.generate(doc(t), { source: 'annotated.flow.yaml' });
  expect(r.ok).toBe(true);
  return r;
};
const main = (t: string) =>
  gen(t).files.find((f) => !f.name.includes('.'))?.text ?? gen(t).files[0]?.text ?? '';

describe('notes as comments in generated code (AFD-66)', () => {
  it('a note on a node is a comment just above its play; free notes, sections and text are not', () => {
    const r = gen(TEXT);
    const file = r.files[0];
    const lines = file?.text.split('\n') ?? [];
    const precheck = doc(TEXT).nodes.find((n) => n.key === 'precheck')?.id as string;
    const range = r.plays[precheck];
    expect(lines[range?.start ?? 0]).toBe('- name: "[precheck] Pre-checks"');
    expect(lines[(range?.start ?? 0) - 1]).toBe('# Note: Read-only checks: safe to rerun.');
    const push = lines.indexOf('# Note: Pushes the baseline:');
    expect(lines.slice(push, push + 4)).toEqual([
      '# Note: Pushes the baseline:',
      '#   - NTP',
      '#   - AAA',
      '#   - SNMP',
    ]);
    expect(file?.text).not.toContain('Runbook');
    expect(file?.text).not.toContain('Change window');
    // Without the notes, the code is the same but for those comments.
    const bare = optionA.generate(withoutAnnotations(doc(TEXT)), { source: 'annotated.flow.yaml' });
    const code = (t: string) =>
      t
        .split('\n')
        .filter((l) => !l.startsWith('#'))
        .join('\n');
    expect(code(file?.text ?? '')).toBe(code(bare.files[0]?.text ?? ''));
  });

  it('no line break turns a note into YAML', () => {
    const breaks = [0x0d, 0x0a, 0x85, 0x2028, 0x2029].map((c) => String.fromCharCode(c));
    const precheck = doc(TEXT).nodes.find((n) => n.key === 'precheck')?.id;
    const evil = planCommand(
      TEXT,
      {
        kind: 'addAnnotation',
        annotation: {
          text: breaks.map((b, i) => `line ${i}${b}- hosts: all${b}  tasks: []`).join(''),
          on: precheck,
          x: 0,
          y: 200,
        },
      },
      { newId: createIdFactory() },
    ).text;
    const text = main(evil);
    for (const line of text.split(/\r\n|[\r\n\u0085\u2028\u2029]/))
      if (line.includes('hosts: all') && !line.includes('{{'))
        expect(line.startsWith('#')).toBe(true);
    expect(parse(text).length).toBe(parse(main(TEXT)).length);
  });
});

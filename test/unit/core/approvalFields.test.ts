// AFD-273: an approval says who decides it (approvers), who is told (notify) and what they read
// (message). The field, its command, what validation says, and that it is not the design.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { CommandError, planCommand } from '../../../src/core/flow/commands';
import { createIdFactory } from '../../../src/core/flow/ids';
import { createSchemaValidator } from '../../../src/core/flow/schema';
import { nodeDesigns } from '../../../src/core/flow/semantic';
import type { FlowDocument } from '../../../src/core/flow/types';
import { validateFlow } from '../../../src/core/flow/validate';
import { applyEdits } from '../../../src/core/yaml';

const TEXT = readFileSync(
  join(__dirname, '../../fixtures/engine/approval-segments.flow.yaml'),
  'utf8',
);
const GATE = '01JCRBN0000000000000000003';
const CHECK = '01JCRBN0000000000000000002';
const ctx = { newId: createIdFactory() };
const schema = createSchemaValidator();
const docOf = (text: string) => parse(text) as FlowDocument;
const nodeOf = (text: string, id: string) => docOf(text).nodes.find((n) => n.id === id);
const update = (text: string, id: string, approval: unknown) => {
  const r = planCommand(
    text,
    { kind: 'updateNode', id, patch: { approval: approval as never } },
    ctx,
  );
  expect(applyEdits(text, r.edits)).toBe(r.text);
  return r.text;
};

describe('AFD-273: approval fields', () => {
  it('are set on an approval, cleaned, and removed with null', () => {
    const text = update(TEXT, GATE, {
      approvers: [' change-board ', 'dana', 'dana', ''],
      notify: ['netops-oncall'],
      message: '  Check the change ticket  ',
    });
    expect(nodeOf(text, GATE)?.approval).toEqual({
      approvers: ['change-board', 'dana'],
      notify: ['netops-oncall'],
      message: 'Check the change ticket',
    });
    expect(schema(docOf(text))).toEqual([]);
    // After settings, before impl: where a writer keeps it.
    const block = text.slice(text.indexOf('key: gate'));
    expect(block.indexOf('approval:')).toBeGreaterThan(block.indexOf('settings:'));
    // Nothing left in it removes it, as null does.
    expect(nodeOf(update(text, GATE, { approvers: [] }), GATE)?.approval).toBeUndefined();
    expect(nodeOf(update(text, GATE, null), GATE)?.approval).toBeUndefined();
  });

  it('are refused on a node that is not an approval', () => {
    expect(() => update(TEXT, CHECK, { approvers: ['dana'] })).toThrow(CommandError);
  });

  it('written by hand on another node, validation says they mean nothing', () => {
    const text = TEXT.replace(
      '    title: Check the change window\n',
      '    title: Check the change window\n    approval:\n      approvers: [dana]\n',
    );
    const findings = validateFlow(docOf(text)).findings.filter((f) => f.code === 'approval-fields');
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ node: CHECK, severity: 'warning' });
    expect(
      validateFlow(docOf(update(TEXT, GATE, { approvers: ['dana'] }))).findings,
    ).not.toContainEqual(expect.objectContaining({ code: 'approval-fields' }));
  });

  it('who approves is not the design: a tested approval stays tested', () => {
    const before = nodeDesigns(docOf(TEXT));
    const after = nodeDesigns(docOf(update(TEXT, GATE, { approvers: ['change-board'] })));
    expect(after[GATE]).toBe(before[GATE]);
  });

  it('the schema refuses what is not one', () => {
    const bad = TEXT.replace(
      '    title: Approve the change\n',
      '    title: Approve the change\n    approval:\n      approvers: dana\n      whoever: true\n',
    );
    expect(schema(docOf(bad)).length).toBeGreaterThan(0);
  });
});

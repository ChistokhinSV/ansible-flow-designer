// AFD-49: flow format versions. Upgrade Flow Format moves every format 1 file in the repository to
// format 2 as one transaction that touches nothing else: the design, the generated code and the
// bytes outside the change stay. Steps run in order; a current or newer file is refused; an edit
// that needs a newer format says how to get it.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { applyOps } from '../../../src/core/ai/ops';
import { optionA } from '../../../src/core/engine/optionA';
import { CommandError, planCommand } from '../../../src/core/flow/commands';
import { createIdFactory } from '../../../src/core/flow/ids';
import {
  CURRENT_FORMAT,
  FormatError,
  formatOf,
  type MigrationStep,
  migrate,
  requireFormat,
  upgradeNotes,
} from '../../../src/core/flow/migrate';
import { createSchemaValidator } from '../../../src/core/flow/schema';
import { newFlowText } from '../../../src/core/flow/template';
import type { FlowDocument } from '../../../src/core/flow/types';
import { setIn } from '../../../src/core/yaml/ops';
import { YamlTransaction } from '../../../src/core/yaml/transaction';

const ROOT = join(__dirname, '../../..');
const schema = createSchemaValidator();
const ctx = { newId: createIdFactory() };

/** Every flow file of the repository that is still format 1: examples, fixtures, handoff. */
function formatOneFlows(): { name: string; text: string }[] {
  const out: { name: string; text: string }[] = [];
  const walk = (dir: string) => {
    for (const f of readdirSync(dir)) {
      const path = join(dir, f);
      if (statSync(path).isDirectory()) walk(path);
      else if (f.endsWith('.flow.yaml')) {
        const text = readFileSync(path, 'utf8');
        if (/^schema_version: 1$/m.test(text)) out.push({ name: relative(ROOT, path), text });
      }
    }
  };
  for (const dir of ['examples', 'test/fixtures']) walk(join(ROOT, dir));
  return out;
}

describe('Upgrade Flow Format', () => {
  const flows = formatOneFlows();

  it('finds format 1 files to upgrade', () => {
    expect(flows.length).toBeGreaterThan(10);
  });

  it.each(flows)(
    '$name: only the version line changes; the design and the code stay',
    ({ name, text }) => {
      const result = planCommand(text, { kind: 'upgradeFormat' }, ctx);
      expect(result.edits).toHaveLength(1);
      expect(result.text).toBe(
        text.replace(/^schema_version: 1$/m, `schema_version: ${CURRENT_FORMAT}`),
      );
      const before = parse(text) as FlowDocument;
      const after = parse(result.text) as FlowDocument;
      expect(formatOf(after)).toBe(CURRENT_FORMAT);
      expect({ ...after, schema_version: 1 }).toEqual(before);
      const issues = (doc: FlowDocument) => schema(doc).map((i) => i.pointer);
      expect(issues(after)).toEqual(issues(before));
      const source = name.split(/[\\/]/).pop() as string;
      const code = (doc: FlowDocument) => optionA.generate(doc, { source });
      expect(JSON.stringify(code(after).files)).toBe(JSON.stringify(code(before).files));
    },
  );

  it('refuses a file already in the current format, and one newer than this extension reads', () => {
    const current = newFlowText('Edge checks', 'edge-checks', createIdFactory());
    expect(formatOf(parse(current))).toBe(CURRENT_FORMAT);
    expect(schema(parse(current))).toEqual([]);
    expect(() => planCommand(current, { kind: 'upgradeFormat' }, ctx)).toThrow(
      expect.objectContaining({ code: 'format-current' }),
    );
    const newer = current.replace(/^schema_version: \d+$/m, 'schema_version: 9');
    let err: unknown;
    try {
      planCommand(newer, { kind: 'upgradeFormat' }, ctx);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(CommandError);
    expect((err as CommandError).code).toBe('format-newer');
    expect((err as Error).message).toMatch(/update the extension/);
  });
});

describe('the steps', () => {
  const v1 = readFileSync(join(ROOT, 'examples/edge-baseline.flow.yaml'), 'utf8');
  const steps: MigrationStep[] = [
    {
      from: 1,
      notes: (doc) => (doc.flow.owner ? [] : ['the owner becomes "netops"']),
      apply: (tx) => void tx.apply((f) => setIn(f, ['flow', 'owner'], 'netops')),
    },
    {
      from: 1,
      notes: () => ['the goal is kept'],
      apply: (tx) => void tx.apply((f) => setIn(f, ['flow', 'goal'], 'Kept by the second step')),
    },
  ];

  it('run in order in one transaction, then the version moves', () => {
    const tx = new YamlTransaction(v1);
    expect(migrate(tx, steps)).toBe(CURRENT_FORMAT);
    const doc = parse(tx.text) as FlowDocument;
    expect(doc.flow.owner).toBe('netops');
    expect(doc.flow.goal).toBe('Kept by the second step');
    expect(formatOf(doc)).toBe(CURRENT_FORMAT);
    // Comments and the order of the file stay where they were.
    expect(tx.text.split('\n')[0]).toBe(v1.split('\n')[0]);
  });

  it('say what they change, for the banner; nothing for a current file', () => {
    const doc = parse(v1) as FlowDocument;
    expect(upgradeNotes(doc, steps)).toEqual(
      doc.flow.owner ? ['the goal is kept'] : ['the owner becomes "netops"', 'the goal is kept'],
    );
    expect(upgradeNotes({ ...doc, schema_version: 2 }, steps)).toEqual([]);
  });

  it('an edit that needs a newer format explains the upgrade', () => {
    const doc = parse(v1) as FlowDocument;
    expect(() => requireFormat(doc, 2, 'A tested record')).toThrow(FormatError);
    expect(() => requireFormat(doc, 2, 'A tested record')).toThrow(/Upgrade Flow Format/);
    expect(() => requireFormat({ ...doc, schema_version: 2 }, 2, 'x')).not.toThrow();
  });
});

describe('the AI tools', () => {
  it('upgrade_format upgrades; a second one says the file is current', async () => {
    const v1 = readFileSync(join(ROOT, 'examples/os-upgrade.flow.yaml'), 'utf8');
    const result = await applyOps(v1, [{ op: 'upgrade_format' }], ctx);
    expect(formatOf(parse(result.text))).toBe(CURRENT_FORMAT);
    await expect(applyOps(result.text, [{ op: 'upgrade_format' }], ctx)).rejects.toThrow(
      /already uses format/,
    );
  });
});

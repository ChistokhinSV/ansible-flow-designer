// AFD-19: what AI assistants read stays in step with the code: the skill's generated references,
// the Copilot tools in package.json, schema descriptions, and the worked examples (they run).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { languageModelTools } from '../../../../src/core/ai/contributions';
import { applyOps, type Op } from '../../../../src/core/ai/ops';
import { referenceFiles } from '../../../../src/core/ai/reference';
import { checkOps } from '../../../../src/core/ai/specs';
import { createIdFactory } from '../../../../src/core/flow/ids';
import { createSchemaValidator } from '../../../../src/core/flow/schema';
import type { FlowDocument } from '../../../../src/core/flow/types';
import { validateFlow } from '../../../../src/core/flow/validate';
import { layoutLevel, shownPositions } from '../../../../src/node/autoLayout';

const ROOT = join(__dirname, '../../../..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8').replaceAll('\r\n', '\n');
const STALE = 'out of date: run `just gen-ai`';

describe('AI assistant files', () => {
  it('the skill references are generated from the current code', () => {
    for (const [name, text] of Object.entries(referenceFiles()))
      expect(read(`skills/ansible-flow/references/${name}`), `${name} ${STALE}`).toBe(text);
  });

  it('package.json offers Copilot the same tools as the MCP server', () => {
    const pkg = JSON.parse(read('package.json'));
    expect(pkg.contributes.languageModelTools, STALE).toEqual(languageModelTools());
    expect(pkg.contributes.chatSkills).toEqual([
      { path: './skills/ansible-flow/SKILL.md', when: '!afd.skillOnDisk' },
    ]);
  });

  it('every schema property says what it is (agents and YAML hovers read it)', () => {
    const missing: string[] = [];
    const walk = (s: unknown, at: string) => {
      if (!s || typeof s !== 'object') return;
      const o = s as Record<string, unknown>;
      for (const [name, p] of Object.entries((o.properties as Record<string, unknown>) ?? {})) {
        if (!(p as { description?: string }).description) missing.push(`${at}.${name}`);
        walk(p, `${at}.${name}`);
      }
      for (const k of ['items', 'additionalProperties']) walk(o[k], `${at}[]`);
      for (const [name, d] of Object.entries((o.$defs as Record<string, unknown>) ?? {}))
        walk(d, `$defs.${name}`);
    };
    walk(JSON.parse(read('schema/flow.schema.json')), '');
    expect(missing).toEqual([]);
  });

  it('SKILL.md follows the Agent Skills format and stays short', () => {
    const skill = read('skills/ansible-flow/SKILL.md');
    const front = /^---\n([\s\S]*?)\n---\n/.exec(skill)?.[1] ?? '';
    const meta = parse(front) as { name: string; description: string };
    expect(meta.name).toBe('ansible-flow');
    expect(meta.description.length).toBeGreaterThan(50);
    expect(meta.description.length).toBeLessThanOrEqual(1024);
    expect(skill.split('\n').length).toBeLessThan(200);
    expect(skill).not.toMatch(/[0-9A-HJKMNP-TV-Z]{26}/);
  });

  it('every worked example runs on the example flow and adds no errors', async () => {
    const flow = read('examples/edge-baseline.flow.yaml');
    const schema = createSchemaValidator();
    const errors = (text: string) => {
      const doc = parse(text) as FlowDocument;
      return validateFlow(doc, schema(doc)).findings.filter((f) => f.severity === 'error');
    };
    const blocks = [...read('skills/ansible-flow/examples.md').matchAll(/```json\n([\s\S]*?)```/g)];
    expect(blocks.length).toBeGreaterThanOrEqual(5);
    for (const [, block] of blocks) {
      const { ops } = JSON.parse(block as string) as { ops: Op[] };
      expect(checkOps(ops)).toEqual([]);
      const r = await applyOps(flow, ops, {
        newId: createIdFactory(),
        layout: layoutLevel,
        positions: shownPositions,
      });
      expect(errors(r.text), block).toEqual([]);
    }
  });
});

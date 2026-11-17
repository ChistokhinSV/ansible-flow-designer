// AFD-290: the sample projects Ansible Flow Server starts a project from (samples/projects.json,
// shipped in @ansible-flow/assets): every file it names is there, and every flow in it reads and
// validates, so a project made from a sample opens without findings that are errors.
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseFlow } from '../../../src/core/flow/document';
import { validateFlow } from '../../../src/core/flow/validate';

const SAMPLES = join(__dirname, '../../../samples');

interface SampleProject {
  key: string;
  name: string;
  description: string;
  files: { from: string; to: string }[];
  launchConfigs?: {
    name: string;
    description?: string;
    flowFile: string;
    inventory?: string;
    mode?: 'check' | 'real';
    inputs?: Record<string, unknown>;
  }[];
}

const { projects } = JSON.parse(readFileSync(join(SAMPLES, 'projects.json'), 'utf8')) as {
  projects: SampleProject[];
};

describe('sample projects', () => {
  it('lists Hello first, each with a name, a description and files', () => {
    expect(projects.map((p) => p.key)).toEqual(['hello', 'edge-baseline', 'firewall-upgrade']);
    for (const p of projects) {
      expect(p.name && p.description, p.key).toBeTruthy();
      expect(p.files.length, p.key).toBeGreaterThan(0);
    }
  });

  it('names files that exist, inside the project, and flows that validate', () => {
    for (const p of projects) {
      const flows = p.files.filter((f) => f.to.endsWith('.flow.yaml'));
      expect(
        flows.map((f) => f.to),
        p.key,
      ).toEqual([`flows/${p.key}/${p.key}.flow.yaml`]);
      for (const f of p.files) {
        expect(existsSync(join(SAMPLES, f.from)), f.from).toBe(true);
        expect(f.to.startsWith('/') || f.to.split('/').includes('..'), f.to).toBe(false);
        if (f.to === '') expect(statSync(join(SAMPLES, f.from)).isDirectory(), f.from).toBe(true);
      }
      const text = readFileSync(join(SAMPLES, flows[0]?.from ?? ''), 'utf8');
      const parsed = parseFlow(text);
      expect(parsed.doc?.flow.key, p.key).toBe(p.key);
      const errors = validateFlow(parsed.doc as never).findings.filter(
        (d) => d.severity === 'error',
      );
      expect(errors, p.key).toEqual([]);
    }
  });

  it('AFD-322: each has a launch configuration of its flow, with every required input', () => {
    for (const p of projects) {
      const configs = p.launchConfigs ?? [];
      expect(configs.length, p.key).toBeGreaterThan(0);
      const names = configs.map((c) => c.name);
      expect(new Set(names).size, p.key).toBe(names.length);
      for (const c of configs) {
        const flow = p.files.find((f) => f.to === c.flowFile);
        expect(flow, `${p.key}: ${c.flowFile}`).toBeTruthy();
        // The inventory is a file the project gets (directly, or inside a folder copied whole).
        if (c.inventory)
          expect(
            p.files.some(
              (f) =>
                f.to === c.inventory ||
                (statSync(join(SAMPLES, f.from)).isDirectory() &&
                  existsSync(
                    join(
                      SAMPLES,
                      f.from,
                      (c.inventory as string).slice(f.to ? f.to.length + 1 : 0),
                    ),
                  )),
            ),
            `${p.key}: ${c.inventory}`,
          ).toBe(true);
        expect(c.mode ?? 'check', p.key).toBe('check');
        const doc = parseFlow(readFileSync(join(SAMPLES, flow?.from ?? ''), 'utf8')).doc;
        const inputs = (doc?.flow.inputs ?? {}) as Record<
          string,
          { required?: boolean; default?: unknown }
        >;
        for (const name of Object.keys(c.inputs ?? {}))
          expect(Object.keys(inputs), `${p.key}: input ${name}`).toContain(name);
        for (const [name, spec] of Object.entries(inputs))
          if (spec.required && spec.default === undefined)
            expect(Object.keys(c.inputs ?? {}), `${p.key}: required ${name}`).toContain(name);
      }
    }
  });
});

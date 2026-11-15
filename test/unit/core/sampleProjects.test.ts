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
});
